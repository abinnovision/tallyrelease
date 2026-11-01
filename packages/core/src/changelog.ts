import { renderTag } from "./tags.js";
import { compare } from "./util.js";

import type { PlanChange, Plan } from "./model/plan-types.js";
import type { Unit, VersionScheme } from "./plugin.js";
import type { Workspace } from "./workspace.js";

/** Commit types in section order; hidden sections list only breaking or Release-As changes. */
const SECTIONS: readonly (readonly [string, string, boolean])[] = [
	["feat", "Features", false],
	["feature", "Features", false],
	["fix", "Bug Fixes", false],
	["perf", "Performance Improvements", false],
	["revert", "Reverts", false],
	["docs", "Documentation", true],
	["style", "Styles", true],
	["chore", "Miscellaneous Chores", true],
	["refactor", "Code Refactoring", true],
	["test", "Tests", true],
	["build", "Build System", true],
	["ci", "Continuous Integration", true],
];
const TITLES = [...new Set(SECTIONS.map(([, title]) => title))];
const FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];
const VERSION_HEADING = /^###? (?:\[v?([^\]\s]+)\]|v?(\S+))/u;
const EDGE_REASON = /^([A-Za-z]+): (.+)$/u;

/** release-please `htmlEscape`: `<` and `>` outside code spans. */
const htmlEscape = (text: string): string =>
	text.replace(/``[^`].*[^`]``|`[^`]*`|<|>/gu, (m) =>
		m.length > 1 ? m : m === "<" ? "&lt;" : "&gt;",
	);

/** Subject with the trailing PR reference the commit header had. */
const withPr = (change: PlanChange): string =>
	change.pr === undefined
		? change.subject
		: `${change.subject} (#${String(change.pr)})`;

/** Subject with its PR, issue and user references linked. */
const subjectOf = (change: PlanChange, repoUrl: string | null): string => {
	const text = htmlEscape(withPr(change));
	if (repoUrl === null) {
		return text;
	}

	const host = repoUrl.split("/").slice(0, 3).join("/");

	return text
		.replace(/#([0-9]+)/gu, (_, n: string) => `[#${n}](${repoUrl}/issues/${n})`)
		.replace(/\B@([a-z0-9](?:-?[a-z0-9/]){0,38})/gu, (m, user: string) =>
			user.includes("/") ? m : `[@${user}](${host}/${user})`,
		);
};

/**
 * Breaking note text as release-please renders it: lines of the first
 * paragraph joined by spaces, except that from the first later line starting
 * with `#### `, `* ` or `- ` on, lines are kept below, indented by four
 * spaces. Without notes, the subject.
 */
const noteOf = (change: PlanChange, repoUrl: string | null): string => {
	let text = "";
	let extended = false;
	for (const [i, line] of (change.notes?.split("\n") ?? []).entries()) {
		if (i > 0 && !extended && /^#### |^[*-] /u.test(line)) {
			text = `${text.trim()}\n`;
			extended = true;
		}

		if (line === "") {
			break;
		}

		text += extended ? `    ${line}\n` : `${line} `;
	}

	text = change.notes === undefined ? withPr(change) : text.trim();

	return repoUrl === null
		? text
		: text.replace(
				/\(#([0-9]+)\)/u,
				(_, n: string) => `([#${n}](${repoUrl}/issues/${n}))`,
			);
};

const scoped = (scope: string | undefined, text: string) =>
	`* ${scope === undefined ? "" : `**${scope}:** `}${text}`;

const via = (change: PlanChange) =>
	change.via === undefined ? "" : ` (via ${change.via})`;

const dependencyLines = (deps: readonly ChangelogDependency[]): string => {
	const rank = (field: string) => {
		const i = FIELDS.indexOf(field);

		return i === -1 ? FIELDS.length : i;
	};

	const fields = [...new Set(deps.map((d) => d.field))].sort(
		(a, b) => rank(a) - rank(b) || compare(a, b),
	);

	return [
		"* The following workspace dependencies were updated",
		...fields.flatMap((field) => [
			`  * ${field}`,
			...deps
				.filter((d) => d.field === field)
				.sort((a, b) => compare(a.name, b.name))
				.map((d) => `    * ${d.name} bumped to ${d.version}`),
		]),
	].join("\n");
};

/** True when a change gets a changelog entry: a listed type, or breaking or Release-As on a hidden one. */
export const isListed = (change: PlanChange): boolean => {
	const section = SECTIONS.find(([type]) => type === change.type.toLowerCase());

	return (
		section !== undefined &&
		(!section[2] || change.breaking || change.releaseAs !== undefined)
	);
};

/** Version of a version heading line, else undefined. */
export const headingVersion = <V>(
	line: string,
	scheme: VersionScheme<V>,
): V | undefined => {
	const m = VERSION_HEADING.exec(line);
	const raw = m?.[1] ?? m?.[2];

	return raw === undefined ? undefined : scheme.parse(raw);
};

/** `<root>/CHANGELOG.md` of a unit. */
export const changelogPath = (unit: Pick<Unit, "root">): string =>
	unit.root === "." ? "CHANGELOG.md" : `${unit.root}/CHANGELOG.md`;

export interface ChangelogDependency {
	/** Manifest field, such as `dependencies`. */
	field: string;
	name: string;
	version: string;
}

/** A cut section of a unit. */
interface CutSection {
	version: string;
	/** Tag of the previous cut; null compares to the base tag. */
	previousCut: string | null;
	/** Changes since the previous cut, core commit order. */
	changes: readonly PlanChange[];
	/** Version of each unit in the prerelease PR. */
	versions: ReadonlyMap<string, string>;
}

export interface ChangelogInput {
	version: string;
	/** `YYYY-MM-DD`, the date the section is generated. */
	date: string;
	/** Repository URL such as `https://github.com/o/r`; null omits all links. */
	repoUrl: string | null;
	/** Previous tag of the unit; null omits the compare link. */
	baseTag: string | null;
	tag: string;
	/** Core commit order. */
	changes: readonly PlanChange[];
	dependencies?: readonly ChangelogDependency[];
	/** Group member: lists a synchronize entry when nothing else is listed. */
	member?: { unit: string; group: string };
}

/**
 * One version section in release-please format: heading, breaking notes,
 * sections by commit type with entries sorted like release-please (scope
 * followed by subject, locale order), then dependencies. No trailing newline.
 */
export const renderChangelogSection = (input: ChangelogInput): string => {
	const { repoUrl, changes } = input;
	const heading =
		input.baseTag !== null && repoUrl !== null
			? `## [${input.version}](${repoUrl}/compare/${input.baseTag}...${input.tag}) (${input.date})`
			: `## ${input.version} (${input.date})`;

	const groups = new Map<string, { key: string; line: string }[]>();
	for (const change of changes) {
		const section = SECTIONS.find(
			([type]) => type === change.type.toLowerCase(),
		);
		if (!section || !isListed(change)) {
			continue;
		}

		const subject = subjectOf(change, repoUrl);
		const link =
			repoUrl === null || change.sha === undefined
				? ""
				: ` ([${change.sha.slice(0, 7)}](${repoUrl}/commit/${change.sha}))`;
		const entries = groups.get(section[1]) ?? [];
		entries.push({
			key: `${change.scope ?? ""}${subject}`,
			line: `${scoped(change.scope, subject)}${link}${via(change)}`,
		});
		groups.set(section[1], entries);
	}

	const notes = changes
		.filter((c) => c.breaking)
		.map((c) => `${scoped(c.scope, noteOf(c, repoUrl))}${via(c)}`);
	if (input.member && notes.length === 0 && groups.size === 0) {
		const { unit, group } = input.member;
		groups.set("Miscellaneous Chores", [
			{ key: "", line: scoped(unit, `Synchronize ${group} versions`) },
		]);
	}

	let text = `${heading}\n\n`;
	if (notes.length > 0) {
		text += `\n### ⚠ BREAKING CHANGES\n\n${notes.map((n) => `${n}\n`).join("")}`;
	}

	for (const title of TITLES) {
		const entries = groups.get(title);
		if (entries) {
			const lines = entries
				.sort((a, b) => a.key.localeCompare(b.key, "en"))
				.map((e) => `${e.line}\n`);
			text += `\n### ${title}\n\n${lines.join("")}\n`;
		}
	}

	text = text.trim();
	const deps = input.dependencies ?? [];

	return deps.length > 0
		? `${text}\n\n\n### Dependencies\n\n${dependencyLines(deps)}`
		: text;
};

/**
 * The changelog section of a unit with a stable `next` in `plan`, else
 * undefined. Dependencies are direct edges from units of the same release PR,
 * named after the edge reason (`<field>: <name>`, else `dependencies` and the
 * unit id). With `cut`, the section is the cut version with the changes since
 * the previous cut, compared to it (else to the base tag), and dependencies
 * at their versions in the prerelease PR.
 */
export const changelogSection = (
	workspace: Workspace,
	plan: Plan,
	opts: {
		id: string;
		repoUrl: string | null;
		date: string;
		/** Units released in the same release PR; dependencies outside it are not listed. */
		prUnits: readonly string[];
		cut?: CutSection;
	},
): string | undefined => {
	const { id, cut } = opts;
	const inPr = new Set(opts.prUnits);
	const units = new Map(workspace.units.map((u) => [u.id, u]));
	const planned = new Map(plan.units.map((u) => [u.id, u]));
	const entry = planned.get(id);
	const unit = units.get(id);
	if (!entry || !unit || entry.next === null) {
		return undefined;
	}

	const dependencies = workspace.graph.edges.flatMap((edge) => {
		const version = cut
			? cut.versions.get(edge.from)
			: planned.get(edge.from)?.next;
		if (
			edge.to !== id ||
			!inPr.has(edge.from) ||
			version === null ||
			version === undefined
		) {
			return [];
		}

		const parsed = edge.reasons.flatMap((r) => {
			const m = EDGE_REASON.exec(r);

			return m?.[1] === undefined || m[2] === undefined
				? []
				: [{ field: m[1], name: m[2], version }];
		});

		return parsed.length > 0
			? parsed
			: [{ field: "dependencies", name: edge.from, version }];
	});

	const version = cut?.version ?? entry.next;

	return renderChangelogSection({
		version,
		date: opts.date,
		repoUrl: opts.repoUrl,
		baseTag: cut ? (cut.previousCut ?? entry.baseTag) : entry.baseTag,
		tag: renderTag(unit, version),
		changes: cut?.changes ?? entry.changes,
		dependencies,
		...(entry.group === null
			? {}
			: { member: { unit: id, group: entry.group } }),
	});
};

/**
 * Inserts `section` on top of the version sections of `content` (undefined or blank:
 * a new file with `# Changelog`). Version headings are `##` or `###` lines,
 * linked or plain. Sections above `baseVersion` are untagged leftovers and are
 * replaced; without a base version, sections not below the new version are,
 * and a stable section also replaces prerelease sections. Text before the
 * first version heading and the other sections stay as they are.
 */
export const updateChangelog = <V>(
	content: string | undefined,
	section: string,
	{
		baseVersion,
		scheme,
	}: { baseVersion: string | null; scheme: VersionScheme<V> },
): string => {
	const lines = (content?.trim() ? content : "# Changelog\n").split("\n");
	const base = baseVersion === null ? undefined : scheme.parse(baseVersion);
	const next = headingVersion(section.split("\n")[0] ?? "", scheme);
	const stale = (v: V) =>
		base !== undefined
			? scheme.compare(v, base) > 0
			: next !== undefined &&
				(scheme.compare(v, next) >= 0 ||
					(!scheme.isPrerelease(next) && scheme.isPrerelease(v)));

	const preamble: string[] = [];
	const kept: string[] = [];
	let keep: boolean | undefined;
	for (const line of lines) {
		const version = headingVersion(line, scheme);
		if (version !== undefined) {
			keep = !stale(version);
		}

		if (keep === undefined) {
			preamble.push(line);
		} else if (keep) {
			kept.push(line);
		}
	}

	const rest = kept.join("\n").trim();

	return `${[preamble.join("\n").trimEnd(), section, rest]
		.filter((part) => part !== "")
		.join("\n\n")}\n`;
};

/**
 * Top version section of unit `id`'s `<root>/CHANGELOG.md`, heading included,
 * read through `read`; undefined without a file or a version section.
 */
export const releaseNotes = (
	workspace: Workspace,
	id: string,
	read: (path: string) => string | undefined,
): string | undefined => {
	const unit = workspace.units.find((u) => u.id === id);
	const scheme = unit && workspace.schemes.get(unit.scheme);
	const content = unit && read(changelogPath(unit));
	if (!scheme || content === undefined) {
		return undefined;
	}

	const section: string[] = [];
	for (const line of content.split("\n")) {
		if (headingVersion(line, scheme) !== undefined) {
			if (section.length > 0) {
				break;
			}
		} else if (section.length === 0) {
			continue;
		}

		section.push(line);
	}

	return section.length === 0 ? undefined : section.join("\n").trim();
};
