import { changelogSection } from "./changelog.js";
import { pluginCtx } from "./plugins.js";
import { matchUnitTags } from "./tags.js";
import { frozenCopy } from "./util.js";
import { pluginSection } from "./version-files.js";

import type { Warning } from "./errors.js";
import type { Plan, PlanChange } from "./model/plan-types.js";
import type { GitReader, ReadonlyFs, VersionScheme } from "./plugin.js";
import type { ReleaseItem } from "./release-items.js";
import type { UnitTag } from "./tags.js";
import type { Workspace } from "./workspace.js";

/** True when `v` renders as `<major>.<minor>.<patch>-<cut>.<n>` with a positive integer `n`. */
export const isCutVersion = <V>(
	scheme: VersionScheme<V>,
	v: V,
	cut: string,
): boolean => {
	const { major, minor, patch } = scheme.core(v);
	const prefix = `${String(major)}.${String(minor)}.${String(patch)}-${cut}.`;
	const formatted = scheme.format(v);

	return (
		formatted.startsWith(prefix) &&
		/^[1-9]\d*$/u.test(formatted.slice(prefix.length))
	);
};

/**
 * Previous cut tag of each unit with a pending release on a line with a cut
 * channel: the highest tag of the cut form below `next`, on `plan.head`'s
 * first-parent chain and past the line base (the plan's `lineBaseTag`, for a
 * group member the highest of its group's); null without one.
 */
export const previousCut = async (
	workspace: Workspace,
	plan: Plan,
	{ git }: { git: GitReader },
): Promise<Map<string, UnitTag | null>> => {
	const cut = plan.line?.cut ?? null;
	const result = new Map<string, UnitTag | null>();
	if (cut === null) {
		return result;
	}

	const matched = matchUnitTags(
		workspace.units,
		await git.tags(),
		workspace.schemes,
	);
	const byName = new Map(
		[...matched.values()].flatMap((m) =>
			m.tags.map((tag) => [tag.name, { tag, scheme: m.scheme }] as const),
		),
	);
	const highest = (names: readonly (string | null)[]): UnitTag | null => {
		let best: { tag: UnitTag; v: unknown } | undefined;
		for (const name of names) {
			const found = name === null ? undefined : byName.get(name);
			const v: unknown = found?.scheme.parse(found.tag.version);
			if (
				found &&
				v !== undefined &&
				(!best || found.scheme.compare(v, best.v) > 0)
			) {
				best = { tag: found.tag, v };
			}
		}

		return best?.tag ?? null;
	};

	const groupBases = new Map(
		plan.groups.map((g) => [
			g.name,
			highest(
				plan.units.filter((u) => u.group === g.name).map((u) => u.lineBaseTag),
			),
		]),
	);

	for (const entry of plan.units) {
		const m = matched.get(entry.id);
		const next: unknown =
			entry.next === null ? undefined : m?.scheme.parse(entry.next);
		if (!m || next === undefined) {
			continue;
		}

		const { scheme } = m;
		const base =
			entry.group === null
				? highest([entry.lineBaseTag])
				: (groupBases.get(entry.group) ?? null);
		const candidates = m.tags
			.filter((t) => {
				const v: unknown = scheme.parse(t.version);

				return (
					v !== undefined &&
					isCutVersion(scheme, v, cut) &&
					scheme.compare(v, next) < 0
				);
			})
			.reverse();
		let found: UnitTag | null = null;
		for (const tag of candidates) {
			if (
				// eslint-disable-next-line no-await-in-loop -- highest first, stops at the first hit
				(await git.isFirstParentAncestor(tag.sha, plan.head)) &&
				// eslint-disable-next-line no-await-in-loop -- highest first, stops at the first hit
				(base === null || !(await git.isAncestor(tag.sha, base.sha)))
			) {
				found = tag;
				break;
			}
		}

		result.set(entry.id, found);
	}

	return result;
};

/** Changes not reachable from the previous cut; all without one. Changes without a sha always count. */
export const cutNotes = async (
	changes: readonly PlanChange[],
	previous: Pick<UnitTag, "sha"> | null,
	{ git }: { git: GitReader },
): Promise<PlanChange[]> => {
	if (previous === null) {
		return [...changes];
	}

	const reached = await Promise.all(
		changes.map(async (c) =>
			c.sha === undefined ? false : await git.isAncestor(c.sha, previous.sha),
		),
	);

	return changes.filter((_, i) => !reached[i]);
};

/**
 * Release notes of a cut of `item` (at its cut version) per member unit: the
 * changelog section of the changes since the previous cut, which the owning
 * plugin's `changelog` hook may replace, as `releaseFiles` renders it.
 */
export const cutReleaseNotes = async (
	workspace: Workspace,
	plan: Plan,
	opts: {
		/** Files of the planned commit, for plugin hooks. */
		fs: ReadonlyFs;
		item: ReleaseItem;
		/** Units released in the same prerelease PR. */
		prUnits: readonly string[];
		/** Version of each unit in the prerelease PR. */
		versions: ReadonlyMap<string, string>;
		/** `YYYY-MM-DD` heading date. */
		date: string;
		repoUrl: string | null;
		git: GitReader;
	},
): Promise<{ notes: Map<string, string>; warnings: Warning[] }> => {
	const { fs, item, prUnits, versions, date, repoUrl, git } = opts;
	const previous = await previousCut(workspace, plan, { git });
	const units = new Map(workspace.units.map((u) => [u.id, u]));
	const planned = new Map(plan.units.map((u) => [u.id, u]));
	const notes = new Map<string, string>();
	const warnings: Warning[] = [];
	const ctx = pluginCtx({ fs, repo: { name: workspace.repo } }, warnings);
	let frozen: Plan | undefined;
	const hookPlan = () => (frozen ??= frozenCopy(plan));
	for (const id of item.units) {
		const unit = units.get(id);
		const entry = planned.get(id);
		const scheme = unit && workspace.schemes.get(unit.scheme);
		if (!unit || !entry || !scheme) {
			continue;
		}

		const previousTag = previous.get(id) ?? null;
		// eslint-disable-next-line no-await-in-loop -- one unit at a time
		const changes = await cutNotes(entry.changes, previousTag, { git });
		const section = changelogSection(workspace, plan, {
			id,
			repoUrl,
			date,
			prUnits,
			cut: {
				version: item.version,
				previousCut: previousTag?.name ?? null,
				changes,
				versions,
			},
		});
		if (section === undefined) {
			continue;
		}

		notes.set(
			id,
			// eslint-disable-next-line no-await-in-loop -- hooks run in order
			await pluginSection(
				{
					workspace,
					plan,
					item,
					unit,
					scheme,
					from: entry.from,
					versions,
					prUnits,
					repoUrl,
					date,
					ctx,
					hookPlan,
					cut: { version: item.version, previousCut: previousTag, changes },
				},
				section,
			),
		);
	}

	return { notes, warnings };
};
