import { coreCodes } from "./codes.js";
import { schemeRegistry } from "./schemes.js";
import { maxLevel } from "./util.js";

import type { Plan } from "./plan.js";
import type { BumpLevel } from "./plugin.js";
import type { ReleaseItem as PrItem } from "./release-items.js";
import type { BranchRule } from "./release.js";
import type { Workspace } from "./workspace.js";

const SPECIAL = /[\\^$.*+?()[\]{}|/]/gu;
const PART = /\{(major|minor)\}|\*/gu;
const CHANNEL = /^[0-9A-Za-z-]+$/u;

const ruleError = (rule: BranchRule, problem: string) =>
	coreCodes.error("E_BRANCH_RULE", `branch rule "${rule.name}" ${problem}`, {
		rule: rule.name,
	});

/** Anchored regex of a rule name; throws `E_BRANCH_RULE`. */
const compileRule = (rule: BranchRule): RegExp => {
	const { name } = rule;
	if (name === "") {
		throw ruleError(rule, "has an empty name");
	}

	const tokens: string[] = name.match(/\{[^{}]*\}/gu) ?? [];
	const unknown = tokens.find((t) => t !== "{major}" && t !== "{minor}");
	if (unknown !== undefined) {
		throw ruleError(rule, `uses unknown token ${unknown}`);
	}

	if (new Set(tokens).size !== tokens.length) {
		throw ruleError(rule, "repeats a token");
	}

	if (tokens.includes("{minor}") && !tokens.includes("{major}")) {
		throw ruleError(rule, "uses {minor} without {major}");
	}

	if (/[{}]/u.test(name.replace(PART, ""))) {
		throw ruleError(rule, "has an unbalanced brace");
	}

	let source = "";
	let last = 0;
	for (const match of name.matchAll(PART)) {
		source += name.slice(last, match.index).replace(SPECIAL, "\\$&");
		source += match[1] === undefined ? ".*" : `(?<${match[1]}>0|[1-9]\\d*)`;
		last = match.index + match[0].length;
	}

	source += name.slice(last).replace(SPECIAL, "\\$&");

	return new RegExp(`^${source}$`, "u");
};

const within = (limit: "minor" | "patch", from: Core, next: Core) =>
	next.major === from.major && (limit === "minor" || next.minor === from.minor);

const itemLabel = ({ unit, group }: ReleaseItem) =>
	unit === null ? `group "${group ?? ""}"` : `unit "${unit}"`;

const itemDetails = ({ unit, group }: ReleaseItem) =>
	unit === null ? { group } : { unit };

/** `c3 web v2 (major)`, with `via` and Release-As when set. */
const commitLabel = ({ sha, subject, level, via, releaseAs }: LimitCommit) => {
	const notes = [
		level === null
			? undefined
			: via === undefined
				? level
				: `${level} via ${via}`,
		releaseAs && `Release-As ${releaseAs.version}`,
	].filter((n) => n !== undefined);

	return `${sha === undefined ? subject : `${sha} ${subject}`} (${notes.join(", ")})`;
};

/** The branch rule matching the planned branch. */
export interface Line {
	rule: string;
	kind: "default" | "maintenance";
	/** Rendered with the rule's captures. */
	channel: string | null;
	/** Maintenance rules: `minor` for `{major}`, `patch` with `{minor}`. */
	maxBump: "minor" | "patch" | null;
	absolute: {
		unit: string | null;
		group: string | null;
		major: number;
		minor?: number;
	} | null;
}

/**
 * Validates rule names, `unit`/`group` and channels: `E_BRANCH_RULE`, `E_CHANNEL_WILDCARD`,
 * `E_CHANNEL_INVALID` and `E_CHANNEL_DUPLICATE`.
 */
export const validateBranches = (rules: readonly BranchRule[]): void => {
	const channels = new Map<string, string>();
	for (const rule of rules) {
		compileRule(rule);
		if (rule.unit !== null && rule.group !== null) {
			throw ruleError(rule, "sets both unit and group");
		}

		if (
			(rule.unit !== null || rule.group !== null) &&
			(rule.line !== "maintenance" || !rule.name.includes("{major}"))
		) {
			throw ruleError(
				rule,
				"sets unit or group without being a maintenance rule with {major}",
			);
		}

		const { channel } = rule;
		if (channel === null) {
			continue;
		}

		if (rule.name.includes("*")) {
			throw coreCodes.error(
				"E_CHANNEL_WILDCARD",
				`branch rule "${rule.name}" contains * and cannot set a channel`,
				{ rule: rule.name, channel },
			);
		}

		const literal = channel.replace(/\{(major|minor)\}/gu, (token) =>
			rule.name.includes(token) ? "0" : token,
		);
		if (
			!CHANNEL.test(literal) ||
			!/[A-Za-z-]/u.test(channel.replace(/\{(major|minor)\}/gu, ""))
		) {
			throw coreCodes.error(
				"E_CHANNEL_INVALID",
				`channel "${channel}" of branch rule "${rule.name}" must match ${CHANNEL.source}, contain a letter or dash and use only tokens captured by the rule`,
				{ rule: rule.name, channel },
			);
		}

		const other = channels.get(channel);
		if (other !== undefined) {
			throw coreCodes.error(
				"E_CHANNEL_DUPLICATE",
				`channel "${channel}" is set by branch rules "${other}" and "${rule.name}"`,
				{ channel, rules: [other, rule.name] },
			);
		}

		channels.set(channel, rule.name);
	}
};

/**
 * The first rule matching `branch`, or null. Rules must be validated. A
 * maintenance rule with `{major}` gets an absolute check for its `unit` or
 * `group`, else for `single`, the repo's only release item.
 */
export const matchBranch = (
	rules: readonly BranchRule[],
	branch: string,
	single: ReleaseItem | null = null,
): Line | null => {
	for (const rule of rules) {
		const match = compileRule(rule).exec(branch);
		if (!match) {
			continue;
		}

		const captures: Record<string, string | undefined> = match.groups ?? {};
		const { major, minor } = captures;
		const capped = rule.line === "maintenance" && major !== undefined;
		const target =
			rule.unit !== null || rule.group !== null
				? { unit: rule.unit, group: rule.group }
				: single;

		return {
			rule: rule.name,
			kind: rule.line,
			channel:
				rule.channel?.replace(
					/\{(major|minor)\}/gu,
					(_, token: string) => captures[token] ?? "",
				) ?? null,
			maxBump: !capped ? null : minor === undefined ? "minor" : "patch",
			absolute:
				!capped || target === null
					? null
					: {
							...target,
							major: Number(major),
							...(minor === undefined ? {} : { minor: Number(minor) }),
						},
		};
	}

	return null;
};

/** An ungrouped released unit or a fixed group. */
export interface ReleaseItem {
	unit: string | null;
	group: string | null;
}

/** Major and minor of a version. */
export interface Core {
	major: number;
	minor: number;
}

/** A formatted version with its core. */
export interface CoreVersion extends Core {
	version: string;
}

/** A commit that contributes to a release item's `next`. */
export interface LimitCommit {
	sha?: string;
	subject: string;
	/** Null for a Release-As only commit. */
	level: BumpLevel | null;
	/** Absorbed unit the change came through. */
	via?: string;
	/** The Release-As value it sets. */
	releaseAs?: CoreVersion;
}

export interface LimitItem extends ReleaseItem {
	/** Null on a first release. */
	from: CoreVersion | null;
	/** Null without a pending release. */
	next: CoreVersion | null;
	commits: readonly LimitCommit[];
}

/**
 * Maintenance limits: `E_CAP_BASE` when the absolute item's `from` is off the
 * rule's line, `E_CAP` when a release item's `next` leaves the line of its
 * `from`. First releases are not checked. `implicit`: the absolute target is
 * the only release item, not named by the rule.
 */
export const checkLimits = (
	line: Line | null,
	items: readonly LimitItem[],
	{ branch, implicit }: { branch: string; implicit: boolean },
): void => {
	const limit = line?.maxBump ?? null;
	if (line === null || limit === null) {
		return;
	}

	const { absolute } = line;
	const target = items.find(
		(i) =>
			absolute !== null &&
			i.unit === absolute.unit &&
			i.group === absolute.group,
	);
	if (absolute !== null && target?.from) {
		const { from } = target;
		if (
			from.major !== absolute.major ||
			(absolute.minor !== undefined && from.minor !== absolute.minor)
		) {
			const expected = [absolute.major, absolute.minor ?? "x"].join(".");
			throw coreCodes.error(
				"E_CAP_BASE",
				`branch "${branch}": ${itemLabel(target)}${implicit ? " (the only release item)" : ""} is at ${from.version}, off the ${expected} line of branch rule "${line.rule}"; the branch was cut from or merged with a commit carrying a newer tag, or names a next major, which maintenance rules do not support (use a default-line rule with a channel)`,
				{
					...itemDetails(target),
					branch,
					rule: line.rule,
					major: absolute.major,
					...(absolute.minor === undefined ? {} : { minor: absolute.minor }),
					from: from.version,
				},
			);
		}
	}

	for (const item of items) {
		const { from, next } = item;
		if (from === null || next === null || within(limit, from, next)) {
			continue;
		}

		const commits = item.commits.filter(
			(c) =>
				(c.level !== null && maxLevel(c.level, limit) !== limit) ||
				(c.releaseAs !== undefined && !within(limit, from, c.releaseAs)),
		);
		const listed = commits.map(commitLabel).join("; ");
		throw coreCodes.error(
			"E_CAP",
			`${itemLabel(item)}: ${from.version} to ${next.version} exceeds the ${limit} limit of branch rule "${line.rule}"${listed === "" ? "" : `; commits: ${listed}`}`,
			{
				...itemDetails(item),
				rule: line.rule,
				limit,
				from: from.version,
				next: next.version,
				commits,
			},
		);
	}
};

/** A maintenance branch to cut at the last release of the previous major. */
export interface MaintenanceCut {
	branch: string;
	tag: string;
	/** `2.x`, or `2.3.x` for a `{minor}` rule. */
	line: string;
}

/**
 * The cut for `item` when a default-line plan releases a new major: the first
 * maintenance rule with `{major}` and no `*` that targets the item or nothing,
 * rendered from `from`, at the item's base tag; else undefined.
 */
export const maintenanceCut = (
	workspace: Workspace,
	plan: Plan,
	item: PrItem,
): MaintenanceCut | undefined => {
	const base =
		item.kind === "group"
			? plan.groups.find((g) => g.name === item.name)
			: plan.units.find((u) => u.id === item.name);
	const unit = workspace.units.find((u) => u.id === item.units[0]);
	const scheme = unit && schemeRegistry(workspace.schemes).get(unit.scheme);
	if (
		plan.line?.kind !== "default" ||
		!scheme ||
		!base?.from ||
		!base.baseTag
	) {
		return undefined;
	}

	const from: unknown = scheme.parse(base.from);
	const next: unknown = scheme.parse(item.version);
	if (from === undefined || next === undefined) {
		return undefined;
	}

	const { major, minor } = scheme.core(from);
	const rule = workspace.release.branches.find(
		(r) =>
			r.line === "maintenance" &&
			r.name.includes("{major}") &&
			!r.name.includes("*") &&
			((r.unit === null && r.group === null) ||
				(item.kind === "group" ? r.group : r.unit) === item.name),
	);
	if (!rule || scheme.core(next).major <= major) {
		return undefined;
	}

	const withMinor = rule.name.includes("{minor}");

	return {
		branch: rule.name
			.replace("{major}", String(major))
			.replace("{minor}", String(minor)),
		tag: base.baseTag,
		line: withMinor
			? `${String(major)}.${String(minor)}.x`
			: `${String(major)}.x`,
	};
};
