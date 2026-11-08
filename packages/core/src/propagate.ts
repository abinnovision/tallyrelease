import { absorbs } from "./bump.js";
import { maxLevel, uniqueSorted } from "./util.js";

import type { Graph } from "./graph.js";
import type { BumpLevel, Edge, Unit } from "./plugin.js";
import type { ReleaseSettings } from "./release-settings.js";

type KindSettings = Pick<ReleaseSettings, "absorbedKinds">;

/**
 * Edges between released units, `to` to `from` to `pinned`. A path through
 * unreleased units counts as an edge with the first hop's `pinned`; several
 * paths are OR-combined. Every hop of a path must be absorbed by its
 * dependent; a direct edge between released units is not filtered.
 */
export const releasedEdges = (
	edges: readonly Edge[],
	released: ReadonlySet<string>,
	settings: KindSettings,
): Map<string, Map<string, boolean>> => {
	const out = new Map<string, Edge[]>();
	for (const e of edges) {
		const list = out.get(e.from) ?? [];
		list.push(e);
		out.set(e.from, list);
	}

	const result = new Map<string, Map<string, boolean>>();
	for (const from of released) {
		const seen = new Set<string>();
		const queue = (out.get(from) ?? [])
			.filter((e) => released.has(e.to) || absorbs(e, settings))
			.map((e) => ({ to: e.to, pinned: e.pinned }));
		for (const { to, pinned } of queue) {
			const key = `${to}\0${String(pinned)}`;
			if (to === from || seen.has(key)) {
				continue;
			}

			seen.add(key);
			if (released.has(to)) {
				const incoming = result.get(to) ?? new Map<string, boolean>();
				incoming.set(from, (incoming.get(from) ?? false) || pinned);
				result.set(to, incoming);
			} else {
				queue.push(
					...(out.get(to) ?? [])
						.filter((e) => absorbs(e, settings))
						.map((e) => ({ to: e.to, pinned })),
				);
			}
		}
	}

	return result;
};

/** Bump state of a released unit. */
export interface Pending {
	readonly bump: BumpLevel | null;
	/** Has a bump or a Release-As value. */
	readonly pending: boolean;
	/** Fixed group name. */
	readonly group?: string;
}

export interface Propagated extends Pending {
	/** Sorted. */
	readonly propagatedFrom: readonly string[];
}

/**
 * Propagation and group fixpoint over released units in graph order. For a
 * pending `from`, the dependent's policy (`auto` = pinned ? patch : rebuild)
 * decides: `patch` raises it to at least patch, `rebuild` changes nothing. A
 * group with a pending member makes every member pending at the members' max
 * bump. Terminates because bumps only increase.
 */
export const propagate = (
	{
		graph,
		units,
		release,
	}: {
		graph: Pick<Graph, "edges" | "order">;
		units: readonly Pick<Unit, "id" | "propagate">[];
		release: KindSettings;
	},
	states: ReadonlyMap<string, Pending>,
): Map<string, Propagated> => {
	const policies = new Map(units.map((u) => [u.id, u.propagate]));
	const groups = new Map<string, string[]>();
	for (const [id, { group }] of states) {
		if (group !== undefined) {
			groups.set(group, [...(groups.get(group) ?? []), id]);
		}
	}

	const edges = releasedEdges(graph.edges, new Set(states.keys()), release);
	const result = new Map<
		string,
		{ bump: BumpLevel | null; pending: boolean; propagatedFrom: Set<string> }
	>(
		[...states].map(([id, s]) => [
			id,
			{ bump: s.bump, pending: s.pending, propagatedFrom: new Set() },
		]),
	);

	let changed = true;
	while (changed) {
		changed = false;
		for (const id of graph.order) {
			const state = result.get(id);
			for (const [from, pinned] of edges.get(id) ?? []) {
				const policy = policies.get(id) ?? "auto";
				const patch = policy === "auto" ? pinned : policy === "patch";
				if (
					!state ||
					!patch ||
					!result.get(from)?.pending ||
					state.propagatedFrom.has(from)
				) {
					continue;
				}

				state.propagatedFrom.add(from);
				state.bump = maxLevel(state.bump, "patch");
				state.pending = true;
				changed = true;
			}
		}

		for (const members of groups.values()) {
			const raised = members.flatMap((id) => result.get(id) ?? []);
			if (!raised.some((s) => s.pending)) {
				continue;
			}

			const bump = raised.reduce<BumpLevel | null>(
				(level, s) => maxLevel(level, s.bump),
				null,
			);
			for (const s of raised) {
				if (!s.pending || s.bump !== bump) {
					s.pending = true;
					s.bump = bump;
					changed = true;
				}
			}
		}
	}

	return new Map(
		[...result].map(([id, s]) => [
			id,
			{ ...s, propagatedFrom: uniqueSorted(s.propagatedFrom) },
		]),
	);
};
