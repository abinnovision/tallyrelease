import type { ReleaseEntry } from "../plan-schema.js";
import type { Plan, PlanChange, Workspace } from "@tallyrelease/core";

/**
 * Changes of unit `id`, then those of the units it was propagated from,
 * transitively. A copied change keeps its `via`, else gets the id of the unit
 * it came from. Shared shas are listed once, sha-less changes always.
 */
const propagatedChanges = (units: Plan["units"], id: string): PlanChange[] => {
	const seenUnits = new Set<string>();
	const seenShas = new Set<string>();
	const visit = (uid: string, via?: string): PlanChange[] => {
		const unit = units.find((u) => u.id === uid);
		if (!unit || seenUnits.has(uid)) {
			return [];
		}

		seenUnits.add(uid);
		const own = unit.changes
			.filter((c) => c.sha === undefined || !seenShas.has(c.sha))
			.map((c) => {
				if (c.sha !== undefined) {
					seenShas.add(c.sha);
				}

				return c.via === undefined && via !== undefined ? { ...c, via } : c;
			});

		return [...own, ...unit.propagatedFrom.flatMap((p) => visit(p, p))];
	};

	return visit(id);
};

/**
 * Releases first (`plan.released` order), then the prereleases in plan unit
 * order, none for a unit released at HEAD. A release lists the changes of the
 * unit in `atParent`, the plan units at the first parent of each release sha;
 * a prerelease those in `plan.units`. Both include propagated changes.
 */
export const releaseListEntries = (
	plan: Plan,
	{ units, groups }: Pick<Workspace, "units" | "groups">,
	atParent: ReadonlyMap<string, Plan["units"]>,
): ReleaseEntry[] => {
	const tags = new Map(units.map((u) => [u.id, [...u.tags]]));
	const group = new Map(
		groups.flatMap((g) => g.members.map((id) => [id, g.name])),
	);
	const line = plan.line?.kind ?? "default";
	const atHead = new Set(
		plan.released.filter((r) => r.releaseSha === plan.head).map((r) => r.id),
	);

	return [
		...plan.released.map((r): ReleaseEntry => ({
			id: r.id,
			path: r.path,
			kind: "release",
			version: r.version,
			channel: null,
			tag: r.tag,
			releaseSha: r.releaseSha,
			catchUp: r.catchUp,
			forge: r.forge,
			latest: r.latest,
			changes: propagatedChanges(atParent.get(r.releaseSha) ?? [], r.id),
			tags: tags.get(r.id) ?? [],
			group: group.get(r.id) ?? null,
			line: r.line,
			buildNumber: null,
		})),
		...plan.units.flatMap((u): ReleaseEntry[] =>
			u.kind === "prerelease" && u.version !== null && !atHead.has(u.id)
				? [
						{
							id: u.id,
							path: u.path,
							kind: "prerelease",
							version: u.version,
							channel: plan.line?.channel ?? null,
							tag: null,
							releaseSha: plan.head,
							catchUp: false,
							forge: null,
							latest: false,
							changes: propagatedChanges(plan.units, u.id),
							tags: u.tags,
							group: u.group,
							line,
							buildNumber: null,
						},
					]
				: [],
		),
	];
};
