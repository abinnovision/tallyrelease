import { coreCodes } from "./codes.js";
import { renderFloatingTags } from "./floating.js";
import { schemeRegistry } from "./schemes.js";
import { matchUnitTags } from "./tags.js";
import { compare } from "./util.js";

import type { Warning } from "./errors.js";
import type { Plan, ReleasedUnit } from "./model/plan-types.js";
import type { GitReader, MaybePromise, VersionScheme } from "./plugin.js";
import type { UnitTag } from "./tags.js";
import type { Workspace } from "./workspace.js";

const stable = (scheme: VersionScheme<any>, version: string): boolean => {
	const v: unknown = scheme.parse(version);

	return v !== undefined && !scheme.isPrerelease(v);
};

/**
 * Released entries of the stable tags `keep` accepts: oldest release commit
 * on the first-parent chain first, then plan unit order (topological), then
 * tag name.
 */
const releasedEntries = async (
	workspace: Workspace,
	plan: Plan,
	{
		git,
		keep,
	}: { git: GitReader; keep: (tag: UnitTag) => MaybePromise<boolean> },
): Promise<ReleasedUnit[]> => {
	const matched = matchUnitTags(
		workspace.units,
		await git.tags(),
		schemeRegistry(workspace.schemes),
	);
	const line = plan.line?.kind ?? "default";
	const built = new Set(
		plan.units.filter((u) => u.affected !== null).map((u) => u.id),
	);
	const candidates = workspace.units.flatMap((unit) => {
		const m = matched.get(unit.id);
		if (!m) {
			return [];
		}

		const names = m.tags.map((t) => t.name);
		const highest = m.tags.findLast((t) => stable(m.scheme, t.version))?.name;

		return m.tags
			.filter((tag) => stable(m.scheme, tag.version))
			.map((tag): ReleasedUnit => ({
				id: unit.id,
				path: unit.root,
				version: tag.version,
				tag: tag.name,
				floatingTags: renderFloatingTags(unit, tag.version, {
					tags: names,
					scheme: m.scheme,
					formats: workspace.release.floating,
				}),
				releaseSha: tag.sha,
				catchUp: tag.sha !== plan.head || !built.has(unit.id),
				forge: null,
				line,
				latest: line !== "maintenance" && tag.name === highest,
			}));
	});
	const kept = await Promise.all(
		candidates.map(
			async (r) =>
				await keep({ name: r.tag, sha: r.releaseSha, version: r.version }),
		),
	);
	const released = candidates.filter((_, i) => kept[i]);

	const shas = [...new Set(released.map((r) => r.releaseSha))];
	const depths = await Promise.all(
		shas.map(async (sha) => await git.countFirstParent(null, sha)),
	);
	const depth = new Map(shas.map((sha, i) => [sha, depths[i] ?? 0]));
	const rank = new Map(workspace.graph.order.map((id, i) => [id, i]));

	return released.sort(
		(a, b) =>
			(depth.get(a.releaseSha) ?? 0) - (depth.get(b.releaseSha) ?? 0) ||
			(rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0) ||
			compare(a.tag, b.tag),
	);
};

/**
 * `plan` with `released`: stable unit tags whose commit is on HEAD's
 * first-parent chain and not an ancestor of `build.base`. With a null base
 * only tags at HEAD, warning `W_RELEASED_NO_BASE` when earlier releases on the
 * chain are left out. A release at HEAD of a unit outside the build set warns
 * `W_RELEASE_NOT_BUILT`.
 */
export const withReleased = async (
	workspace: Workspace,
	plan: Plan,
	{ git }: { git: GitReader },
): Promise<Plan> => {
	const { head } = plan;
	const { base } = plan.build;
	const atBase =
		base === null
			? new Set<string>()
			: new Set((await git.tagsMerged(base)).map((t) => t.name));
	let omitted = 0;
	const released = await releasedEntries(workspace, plan, {
		git,
		keep: async (tag) => {
			if (
				atBase.has(tag.name) ||
				!(await git.isFirstParentAncestor(tag.sha, head))
			) {
				return false;
			}

			if (base === null && tag.sha !== head) {
				omitted += 1;

				return false;
			}

			return true;
		},
	});
	const warnings: Warning[] = [
		...(omitted === 0
			? []
			: [
					coreCodes.warning(
						"W_RELEASED_NO_BASE",
						"the build base is unknown; released leaves out earlier releases on the first-parent chain",
					),
				]),
		...released
			.filter((r) => r.releaseSha === head && r.catchUp)
			.map((r) =>
				coreCodes.warning(
					"W_RELEASE_NOT_BUILT",
					`release ${r.tag} is at HEAD but unit ${r.id} is not in the build set; it is listed as a catch-up`,
					{ unit: r.id },
				),
			),
	];

	return { ...plan, released, warnings: [...plan.warnings, ...warnings] };
};

/**
 * Released entries of the named tags, in `plan.released` order; names that
 * are not stable tags of a released unit are skipped. Callers add the tags a
 * reconcile created by passing the union of those and `plan.released` tags.
 */
export const releasedFromTags = async (
	workspace: Workspace,
	plan: Plan,
	{ git, tags }: { git: GitReader; tags: readonly string[] },
): Promise<ReleasedUnit[]> => {
	const names = new Set(tags);

	return await releasedEntries(workspace, plan, {
		git,
		keep: (tag) => names.has(tag.name),
	});
};
