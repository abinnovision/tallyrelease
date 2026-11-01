import { coreCodes } from "./codes.js";
import { releasedEdges } from "./propagate.js";
import { renderTag } from "./tags.js";

import type { ReleasePrMode } from "./config.js";
import type { Warning } from "./errors.js";
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

/** Marker releases equal the entries of `items` and touch only complete items. */
const markerEquals = (
	marker: readonly MarkerRelease[],
	items: readonly ReleaseItem[],
): boolean => {
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

/** A group or an ungrouped released unit; releases as one. */
export interface ReleaseItem {
	name: string;
	kind: "unit" | "group";
	mode: ReleasePrMode;
	/** Sorted member ids; the unit itself for kind `unit`. */
	units: string[];
	/** Stable `next`. */
	next: string;
	/** Released version: `next`, or the cut version. */
	version: string;
	/** Version tag of each member, in `units` order. */
	tags: { id: string; tag: string }[];
}

/**
 * Pending release items (stable `next`) in plan unit order. With `cut`, items
 * at their cut version; items that cannot be cut are left out.
 */
export const releaseItems = (
	workspace: Workspace,
	plan: Plan,
	{ cut = false }: { cut?: boolean } = {},
): ReleaseItem[] => {
	const units = new Map(workspace.units.map((u) => [u.id, u]));
	const groups = new Map(plan.groups.map((g) => [g.name, g]));
	const byUnit = itemsByUnit(workspace);
	const items = new Map<string, ReleaseItem>();
	for (const entry of plan.units) {
		const { id, next } = entry;
		const item = byUnit.get(id);
		if (next === null || !item || items.has(item.name)) {
			continue;
		}

		let version: string | null = next;
		if (cut) {
			version =
				item.kind === "group"
					? (groups.get(item.name)?.cut ?? null)
					: entry.cut;
		}

		if (version === null) {
			continue;
		}

		items.set(item.name, {
			...item,
			next,
			version,
			tags: item.units.flatMap((u) => {
				const unit = units.get(u);

				return unit ? [{ id: u, tag: renderTag(unit, version) }] : [];
			}),
		});
	}

	return [...items.values()];
};

/** `W_CUT_SCHEME` for each unit with a pending release that cannot be cut on a line with a cut channel. */
export const cutWarnings = (plan: Plan): Warning[] => {
	const cut = plan.line?.cut ?? null;
	if (cut === null) {
		return [];
	}

	return plan.units
		.filter((u) => u.next !== null && u.cut === null)
		.map((u) =>
			coreCodes.warning(
				"W_CUT_SCHEME",
				`unit "${u.id}" (scheme ${u.scheme}) cannot be cut on channel "${cut}"`,
				{ unit: u.id },
			),
		);
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
): boolean => markerEquals(marker, releaseItems(workspace, plan));

/**
 * `planEquals` for a prerelease PR: the marker equals the cut releases at
 * `atH` (the marker head), and each item it touches has the same `next` and
 * members at `atP`, on a line with the same cut channel. Other items are
 * ignored.
 */
export const cutEquals = (
	marker: readonly MarkerRelease[],
	atH: { workspace: Workspace; plan: Plan },
	atP: { workspace: Workspace; plan: Plan },
): boolean => {
	const items = releaseItems(atH.workspace, atH.plan, { cut: true });
	const later = new Map(
		releaseItems(atP.workspace, atP.plan).map((i) => [i.name, i]),
	);
	const ids = new Set(marker.map((r) => r.id));

	return (
		markerEquals(marker, items) &&
		(atH.plan.line?.cut ?? null) === (atP.plan.line?.cut ?? null) &&
		items
			.filter((item) => item.units.some((id) => ids.has(id)))
			.every((item) => {
				const other = later.get(item.name);

				return (
					other?.next === item.next &&
					other.units.join("\0") === item.units.join("\0")
				);
			})
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
