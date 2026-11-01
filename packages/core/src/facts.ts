import { attribution, matcher } from "./attribution.js";
import { coreCodes } from "./codes.js";
import { pluginCtx, runHook } from "./plugins.js";
import { matchUnitTags } from "./tags.js";
import { compare, uniqueSorted } from "./util.js";

import type { Warning } from "./errors.js";
import type {
	AttributedChange,
	GroupFacts,
	PlanFacts,
	RangeFacts,
	UnitFacts,
} from "./model/facts-types.js";
import type {
	Change,
	GitReader,
	RawCommit,
	ReadonlyFs,
	ReleaseAsValue,
	VersionScheme,
} from "./plugin.js";
import type { UnitTag } from "./tags.js";
import type { Workspace } from "./workspace.js";

const instant = (commit: RawCommit): number => {
	const time = Date.parse(commit.date);
	if (Number.isNaN(time)) {
		throw coreCodes.error(
			"E_GIT_DATE",
			`commit ${commit.sha} has an invalid committer date "${commit.date}"`,
			{ sha: commit.sha, date: commit.date },
		);
	}

	return time;
};

/** Committer date descending, compared as instants, then sha. */
const byCommitOrder = (a: RawCommit, b: RawCommit): number =>
	instant(b) - instant(a) || compare(a.sha, b.sha);

const releaseAsKey = (r: ReleaseAsValue) => `${r.unit ?? ""}@${r.version}`;

/** Keeps the first commit-derived Change per dedupe key, unioning `releaseAs`. */
const dedupe = (changes: readonly Change[]): Change[] => {
	const kept: Change[] = [];
	const index = new Map<string, number>();
	for (const change of changes) {
		const key =
			change.sha === undefined
				? undefined
				: [
						change.sha,
						change.type,
						String(change.breaking),
						uniqueSorted(change.units ?? []).join(","),
					].join("\0");
		const at = key === undefined ? undefined : index.get(key);
		const prior = at === undefined ? undefined : kept[at];
		if (at === undefined || !prior) {
			if (key !== undefined) {
				index.set(key, kept.length);
			}

			kept.push(change);
			continue;
		}

		if (change.releaseAs) {
			const values = new Map(
				[...(prior.releaseAs ?? []), ...change.releaseAs].map((r) => [
					releaseAsKey(r),
					r,
				]),
			);
			kept[at] = { ...prior, releaseAs: [...values.values()] };
		}
	}

	return kept;
};

type LineFacts = Awaited<ReturnType<typeof lineFacts>>;

interface UnitBase {
	scheme: VersionScheme<any>;
	baseTag: UnitTag | null;
	lineBaseTag: UnitTag | null;
	introduced: string | null;
	sinceLineBase: number;
}

export interface FactsOptions {
	head: string;
	fs: ReadonlyFs;
	debug?: (message: string) => void;
}

/** First-parent commit counters of `head`, memoized per commit. */
export const lineFacts = async (git: GitReader, head: string) => {
	const total = await git.countFirstParent(null, head);
	const counts = new Map<string, number>();
	const countSince = async (sha: string): Promise<number> => {
		const cached = counts.get(sha);
		if (cached !== undefined) {
			return cached;
		}

		const count = await git.countFirstParent(sha, head);
		counts.set(sha, count);

		return count;
	};

	/** Counter since the line base; without one, since the unit's introduction. */
	const lineCount = async (root: string, lineBaseTag: UnitTag | null) => {
		if (lineBaseTag) {
			return {
				introduced: null,
				sinceLineBase: await countSince(lineBaseTag.sha),
			};
		}

		const introduced = root === "." ? null : await git.introduced(root, head);

		return {
			introduced,
			sinceLineBase:
				introduced === null ? total : (await countSince(introduced)) + 1,
		};
	};

	return { head, total, countSince, lineCount };
};

/** Tags of every unit and fixed group, relative to `head`. */
export const tagFacts = async (
	workspace: Workspace,
	git: GitReader,
	line: LineFacts,
) => {
	const { head } = line;
	const { schemes } = workspace;
	const allTags = await git.tags();
	const tags = matchUnitTags(workspace.units, allTags, schemes);
	const merged = new Set((await git.tagsMerged(head)).map((t) => t.name));

	const ancestry = new Map<string, boolean>();
	const isAncestor = async (a: string, b: string): Promise<boolean> => {
		const key = `${a}\0${b}`;
		const cached = ancestry.get(key);
		if (cached !== undefined) {
			return cached;
		}

		const result = await git.isAncestor(a, b);
		ancestry.set(key, result);

		return result;
	};

	/** The higher tag; equal versions prefer the tag descending from the other. */
	const higher = async (
		scheme: VersionScheme<any>,
		a: UnitTag | null,
		b: UnitTag | null,
	): Promise<UnitTag | null> => {
		if (a === null || b === null) {
			return a ?? b;
		}

		const x: unknown = scheme.parse(a.version);
		const y: unknown = scheme.parse(b.version);
		// Members with another scheme fail validateRelease (E_GROUP_SCHEME).
		if (x === undefined || y === undefined) {
			return a;
		}

		const order = scheme.compare(y, x);
		if (order !== 0) {
			return order > 0 ? b : a;
		}

		return a.sha !== b.sha && (await isAncestor(a.sha, b.sha)) ? b : a;
	};

	const bases = new Map<string, UnitBase>();
	for (const unit of workspace.units) {
		const matched = tags.get(unit.id);
		if (!matched) {
			// Unreleased.
			continue;
		}

		const { scheme } = matched;
		const stable = matched.tags.filter(
			(t) =>
				merged.has(t.name) && !scheme.isPrerelease(scheme.parse(t.version)),
		);
		let lineBaseTag: UnitTag | null = null;
		for (const tag of [...stable].reverse()) {
			// eslint-disable-next-line no-await-in-loop -- stops at the first match
			if (await git.isFirstParentAncestor(tag.sha, head)) {
				lineBaseTag = tag;
				break;
			}
		}

		bases.set(unit.id, {
			scheme,
			baseTag: stable.at(-1) ?? null,
			lineBaseTag,
			// eslint-disable-next-line no-await-in-loop -- one git call per unit
			...(await line.lineCount(unit.root, lineBaseTag)),
		});
	}

	const groups: GroupFacts[] = [];
	for (const { name, members } of workspace.groups) {
		let baseTag: UnitTag | null = null;
		let lineBaseTag: UnitTag | null = null;
		for (const id of members) {
			const own = bases.get(id);
			if (own) {
				// eslint-disable-next-line no-await-in-loop -- memoized ancestry
				baseTag = await higher(own.scheme, baseTag, own.baseTag);
				// eslint-disable-next-line no-await-in-loop -- memoized ancestry
				lineBaseTag = await higher(own.scheme, lineBaseTag, own.lineBaseTag);
			}
		}

		groups.push({
			name,
			members,
			baseTag,
			lineBaseTag,
			sinceLineBase: lineBaseTag
				? // eslint-disable-next-line no-await-in-loop -- memoized per line base
					await line.countSince(lineBaseTag.sha)
				: Math.max(
						0,
						...members.map((id) => bases.get(id)?.sinceLineBase ?? 0),
					),
		});
	}

	return {
		tags,
		bases,
		groups,
		isAncestor,
		tagNames: uniqueSorted(allTags.map((t) => t.name)),
	};
};

/** Attributed changes of `(from, head]`, memoized per `from`. */
export const rangeFacts = (
	workspace: Workspace,
	git: GitReader,
	opts: FactsOptions,
) => {
	const { head } = opts;
	const warnings: Warning[] = [];
	const ctx = pluginCtx({ ...opts, repo: { name: workspace.repo } }, warnings);
	const intents = workspace.intents.map((entry) => ({
		...entry,
		ctx: ctx(entry.plugin, entry.options),
	}));
	const ignored = matcher(workspace.ignore);
	const isGlobal = matcher(workspace.globalInputs);
	const owners = attribution(workspace.units);
	const known = new Set(workspace.units.map((u) => u.id));
	// File-less commits belong to every released unit (release-please parity).
	const released = workspace.units
		.filter((u) => u.version !== "none")
		.map((u) => u.id);
	const warned = new Set<string>();
	const warnUnknown = (plugin: string, changes: readonly Change[]) => {
		for (const id of changes.flatMap((c) => c.units ?? [])) {
			const key = `${plugin}\0${id}`;
			if (!known.has(id) && !warned.has(key)) {
				warned.add(key);
				warnings.push(
					coreCodes.warning(
						"W_UNIT_UNKNOWN",
						`intent names unknown unit "${id}"`,
						{ plugin },
					),
				);
			}
		}
	};

	const ranges = new Map<string | null, RangeFacts>();
	const range = async (from: string | null): Promise<RangeFacts> => {
		const cached = ranges.get(from);
		if (cached) {
			return cached;
		}

		const commits = Object.freeze(
			[...(await git.log(from, head))].sort(byCommitOrder),
		);
		const position = new Map(commits.map((c, i) => [c.sha, i]));
		const commitUnits = new Map(
			commits.map((c) => [
				c.sha,
				c.files.length === 0
					? released
					: uniqueSorted(
							c.files
								.filter((f) => !ignored(f) && !isGlobal(f))
								.flatMap(owners),
						),
			]),
		);

		const changes: Change[] = [];
		for (const { plugin, source, ctx: sourceCtx } of intents) {
			// eslint-disable-next-line no-await-in-loop -- hooks run sequentially in config order
			const collected = await runHook(plugin, "intent", () =>
				source.collect(sourceCtx, { from, to: head, commits }),
			);
			warnUnknown(plugin, collected);
			changes.push(...collected);
		}

		const attributed = dedupe(changes)
			.map((change): AttributedChange => ({
				change,
				units: change.units
					? uniqueSorted(change.units.filter((id) => known.has(id)))
					: (commitUnits.get(change.sha ?? "") ?? []),
			}))
			.sort(
				(a, b) =>
					(position.get(a.change.sha ?? "") ?? commits.length) -
					(position.get(b.change.sha ?? "") ?? commits.length),
			);

		const result = { from, changes: attributed };
		ranges.set(from, result);

		return result;
	};

	return { range, all: () => [...ranges.values()], warnings };
};

/** Runs every `GitReader` and intent source call a plan needs. */
export const collectPlanFacts = async (
	workspace: Workspace,
	git: GitReader,
	opts: FactsOptions,
): Promise<PlanFacts> => {
	const { head } = opts;
	const date = await git.commitDate?.(head);
	const line = await lineFacts(git, head);
	const { tags, bases, groups, isAncestor, tagNames } = await tagFacts(
		workspace,
		git,
		line,
	);
	const { range, all, warnings } = rangeFacts(workspace, git, opts);

	const groupOf = new Map(
		groups.flatMap((g) => g.members.map((id) => [id, g])),
	);

	const units: UnitFacts[] = [];
	for (const unit of workspace.units) {
		const matched = tags.get(unit.id);
		const own = bases.get(unit.id);
		if (!matched || !own) {
			continue;
		}

		const { baseTag, lineBaseTag, introduced, sinceLineBase } = own;
		const group = groupOf.get(unit.id);
		const fromTag = group ? group.baseTag : baseTag;
		const rangeBase =
			group &&
			baseTag &&
			fromTag &&
			baseTag.sha !== fromTag.sha &&
			// eslint-disable-next-line no-await-in-loop -- memoized ancestry
			(await isAncestor(fromTag.sha, baseTag.sha))
				? baseTag
				: fromTag;
		// eslint-disable-next-line no-await-in-loop -- intent sources run sequentially
		const { from, changes } = await range(rangeBase?.sha ?? null);
		units.push({
			id: unit.id,
			group: group?.name ?? null,
			from,
			tags: matched.tags,
			baseTag,
			fromTag,
			lineBaseTag,
			introduced,
			sinceLineBase,
			total: line.total,
			changes: changes.filter((c) => c.units.includes(unit.id)),
			releaseAs: changes.flatMap(({ change }) =>
				(change.releaseAs ?? [])
					.filter((r) => r.unit === unit.id)
					.map((r) => ({
						...(change.sha === undefined ? {} : { sha: change.sha }),
						version: r.version,
					})),
			),
		});
	}

	return {
		head,
		...(date === undefined ? {} : { date }),
		units,
		ranges: all(),
		groups,
		tagNames,
		warnings,
	};
};
