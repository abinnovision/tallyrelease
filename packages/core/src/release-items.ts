import { coreCodes } from "./codes.js";
import { releasedEdges } from "./propagate.js";
import { renderTag } from "./tags.js";

import type { ReleasePrMode } from "./config.js";
import type { MarkerRelease } from "./marker.js";
import type { Plan } from "./model/plan-types.js";
import type { Workspace } from "./workspace.js";

type ItemShape = Pick<ReleaseItem, "name" | "kind" | "mode" | "units">;

/** Item of each released unit, by unit id. */
const itemsByUnit = (workspace: Workspace): Map<string, ItemShape> => {
	const { releasePr } = workspace.release;
	const byUnit = new Map<string, ItemShape>();
	for (const { name, members } of workspace.groups) {
		const item: ItemShape = {
			name,
			kind: "group",
			mode: releasePr.groups.get(name) ?? releasePr.default,
			units: [...members],
		};
		for (const id of members) {
			byUnit.set(id, item);
		}
	}

	for (const { id, version } of workspace.units) {
		if (version !== "none" && !byUnit.has(id)) {
			byUnit.set(id, {
				name: id,
				kind: "unit",
				mode: releasePr.units.get(id) ?? releasePr.default,
				units: [id],
			});
		}
	}

	return byUnit;
};

/** Why `name` cannot name a release item, else undefined. */
const itemNameProblem = (name: string): string | undefined => {
	if (name === "shared") {
		return "is reserved for the shared release PR";
	}

	return name.startsWith(".") ||
		name.endsWith(".") ||
		name.endsWith(".lock") ||
		name.includes("..")
		? "does not form a valid branch name"
		: undefined;
};

/** A group or an ungrouped released unit; releases as one. */
export interface ReleaseItem {
	name: string;
	kind: "unit" | "group";
	mode: ReleasePrMode;
	/** Sorted member ids; the unit itself for kind `unit`. */
	units: string[];
	/** Stable `next`. */
	version: string;
	/** Version tag of each member, in `units` order. */
	tags: { id: string; tag: string }[];
}

/** Pending release items (stable `next`) in plan unit order. */
export const releaseItems = (
	workspace: Workspace,
	plan: Plan,
): ReleaseItem[] => {
	const units = new Map(workspace.units.map((u) => [u.id, u]));
	const byUnit = itemsByUnit(workspace);
	const items = new Map<string, ReleaseItem>();
	for (const { id, next } of plan.units) {
		const item = byUnit.get(id);
		if (next === null || !item || items.has(item.name)) {
			continue;
		}

		items.set(item.name, {
			...item,
			version: next,
			tags: item.units.flatMap((u) => {
				const unit = units.get(u);

				return unit ? [{ id: u, tag: renderTag(unit, next) }] : [];
			}),
		});
	}

	return [...items.values()];
};

/** One release per item member. */
export const releaseEntries = (
	items: readonly ReleaseItem[],
): MarkerRelease[] =>
	items.flatMap((item) =>
		item.tags.map(({ id, tag }) => ({ id, version: item.version, tag })),
	);

/**
 * True when every marker release equals the plan's release of that unit and
 * every item the marker touches is complete. Pending items outside the marker
 * are ignored; an empty marker never equals.
 */
export const planEquals = (
	marker: readonly MarkerRelease[],
	plan: Plan,
	workspace: Workspace,
): boolean => {
	const items = releaseItems(workspace, plan);
	const entries = new Map(releaseEntries(items).map((e) => [e.id, e]));
	const ids = new Set(marker.map((r) => r.id));

	return (
		marker.length > 0 &&
		marker.every((r) => {
			const entry = entries.get(r.id);

			return entry?.version === r.version && entry.tag === r.tag;
		}) &&
		items.every(
			(item) =>
				item.units.every((id) => ids.has(id)) ||
				!item.units.some((id) => ids.has(id)),
		)
	);
};

/**
 * Release PR checks: `releasePr` only on ungrouped units (`E_CONFIG`), item
 * names (`E_RELEASE_ITEM_NAME`) and patch-propagating edges between items in
 * different release PRs (`E_RELEASE_PR_SPLIT_EDGE`).
 */
export const validateReleaseItems = (workspace: Workspace): void => {
	const byUnit = itemsByUnit(workspace);
	for (const id of workspace.release.releasePr.units.keys()) {
		const item = byUnit.get(id);
		if (item?.kind === "group") {
			throw coreCodes.error(
				"E_CONFIG",
				`unit "${id}" sets releasePr but is in group "${item.name}"; set it on the group`,
				{ unit: id, group: item.name },
			);
		}
	}

	const groups = new Set(workspace.groups.map((g) => g.name));
	for (const item of new Set(byUnit.values())) {
		const problem =
			item.kind === "unit" && groups.has(item.name)
				? "is also a group name"
				: itemNameProblem(item.name);
		if (problem !== undefined) {
			throw coreCodes.error(
				"E_RELEASE_ITEM_NAME",
				`release item "${item.name}" ${problem}`,
				{ item: item.name },
			);
		}
	}

	const policies = new Map(workspace.units.map((u) => [u.id, u.propagate]));
	const pr = (item: ItemShape) =>
		item.mode === "shared" ? "shared" : item.name;
	const edges = releasedEdges(workspace.graph.edges, new Set(byUnit.keys()));
	for (const [to, incoming] of edges) {
		const policy = policies.get(to) ?? "auto";
		for (const [from, pinned] of incoming) {
			const a = byUnit.get(from);
			const b = byUnit.get(to);
			const patch = policy === "auto" ? pinned : policy === "patch";
			if (!a || !b || !patch || pr(a) === pr(b)) {
				continue;
			}

			throw coreCodes.error(
				"E_RELEASE_PR_SPLIT_EDGE",
				`edge "${from}" -> "${to}" propagates a patch between release items "${a.name}" and "${b.name}" in different release PRs`,
				{ from, to, items: [a.name, b.name] },
			);
		}
	}
};
