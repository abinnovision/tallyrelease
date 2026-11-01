import { matchUnitTags } from "./tags.js";

import type { CutChanges } from "./changelog.js";
import type { Plan, PlanChange } from "./model/plan-types.js";
import type { GitReader, VersionScheme } from "./plugin.js";
import type { ReleaseItem } from "./release-items.js";
import type { UnitTag } from "./tags.js";
import type { Workspace } from "./workspace.js";

/**
 * Changes not reachable from the previous cut; all without one. A change
 * without a sha counts when one of its files changed since the previous cut.
 */
const cutNotes = async (
	changes: readonly PlanChange[],
	previous: Pick<UnitTag, "sha"> | null,
	{ git, head }: { git: GitReader; head: string },
): Promise<PlanChange[]> => {
	if (previous === null) {
		return [...changes];
	}

	const changed = changes.some((c) => c.sha === undefined)
		? new Set(await git.diffFiles(previous.sha, head))
		: new Set<string>();
	const reached = await Promise.all(
		changes.map(async (c) =>
			c.sha === undefined
				? !(c.files ?? []).some((f) => changed.has(f))
				: await git.isAncestor(c.sha, previous.sha),
		),
	);

	return changes.filter((_, i) => !reached[i]);
};

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

/**
 * Cut changelog input of each member of the cut `items`: its previous cut
 * and the changes since it.
 */
export const cutChanges = async (
	workspace: Workspace,
	plan: Plan,
	{ items, git }: { items: readonly ReleaseItem[]; git: GitReader },
): Promise<Map<string, CutChanges>> => {
	const previous = await previousCut(workspace, plan, { git });
	const planned = new Map(plan.units.map((u) => [u.id, u.changes]));
	const ids = items.flatMap((i) => i.units);

	return new Map(
		await Promise.all(
			ids.map(async (id) => {
				const tag = previous.get(id) ?? null;
				const changes = await cutNotes(planned.get(id) ?? [], tag, {
					git,
					head: plan.head,
				});

				return [id, { previousCut: tag, changes }] as const;
			}),
		),
	);
};
