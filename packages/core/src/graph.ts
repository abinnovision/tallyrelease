import { coreCodes } from "./codes.js";
import { compare, uniqueSorted } from "./util.js";

import type { Warning } from "./errors.js";
import type { Edge, EdgeDraft, Unit } from "./plugin.js";

/** Tarjan's algorithm; components are emitted after everything they reach. */
const stronglyConnected = (
	ids: readonly string[],
	next: ReadonlyMap<string, readonly string[]>,
): string[][] => {
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const stack: string[] = [];
	const onStack = new Set<string>();
	const components: string[][] = [];

	const visit = (v: string): void => {
		const own = index.size;
		index.set(v, own);
		low.set(v, own);
		stack.push(v);
		onStack.add(v);
		for (const w of next.get(v) ?? []) {
			if (!index.has(w)) {
				visit(w);
				low.set(v, Math.min(low.get(v) ?? own, low.get(w) ?? own));
			} else if (onStack.has(w)) {
				low.set(v, Math.min(low.get(v) ?? own, index.get(w) ?? own));
			}
		}

		if (low.get(v) === own) {
			const component: string[] = [];
			let w: string | undefined;
			do {
				w = stack.pop();
				if (w !== undefined) {
					onStack.delete(w);
					component.push(w);
				}
			} while (w !== undefined && w !== v);

			components.push(component.sort(compare));
		}
	};

	for (const id of ids) {
		if (!index.has(id)) {
			visit(id);
		}
	}

	return components;
};

/** Shortest cycle through the smallest member id, following dependents. */
const cyclePath = (
	component: readonly string[],
	dependents: ReadonlyMap<string, readonly string[]>,
): string[] => {
	const members = new Set(component);
	const start = component[0] ?? "";
	const parent = new Map<string, string>();
	const queue = [start];
	for (const v of queue) {
		for (const w of dependents.get(v) ?? []) {
			if (w === start) {
				const path: string[] = [];
				for (
					let n: string | undefined = v;
					n !== undefined;
					n = parent.get(n)
				) {
					path.unshift(n);
				}

				return [...path, start];
			}

			if (members.has(w) && !parent.has(w)) {
				parent.set(w, v);
				queue.push(w);
			}
		}
	}

	return [start, start];
};

/** Edge draft with its origin: a plugin name or `config`. */
export interface SourcedEdge extends EdgeDraft {
	source: string;
}

export interface Graph {
	/** Deduplicated edges sorted by `from`, then `to`. */
	readonly edges: readonly Edge[];
	/** Unit id to the sorted ids of units depending on it. */
	readonly dependents: ReadonlyMap<string, readonly string[]>;
	/** Unit id to the sorted ids of units it depends on. */
	readonly dependencies: ReadonlyMap<string, readonly string[]>;
	/** Dependencies before dependents; members of a cycle by id. */
	readonly order: readonly string[];
	readonly warnings: readonly Warning[];
}

/** Validates and deduplicates edges, then derives adjacency and order. */
export const buildGraph = (
	units: readonly Unit[],
	drafts: readonly SourcedEdge[],
): Graph => {
	const ids = units.map((u) => u.id).sort(compare);
	const known = new Set(ids);
	const merged = new Map<
		string,
		{
			from: string;
			to: string;
			reasons: string[];
			pinned: boolean;
			sources: string[];
		}
	>();

	for (const { from, to, reason, pinned, source } of drafts) {
		for (const id of [from, to]) {
			if (!known.has(id)) {
				throw coreCodes.error(
					"E_EDGE_UNKNOWN_UNIT",
					`edge ${from} -> ${to} from "${source}" names unknown unit "${id}"`,
					{ from, to, source, unit: id },
				);
			}
		}

		if (from === to) {
			throw coreCodes.error(
				"E_EDGE_SELF",
				`edge ${from} -> ${to} from "${source}" points to itself`,
				{ from, to, source },
			);
		}

		const key = `${from}\n${to}`;
		const edge = merged.get(key);
		if (edge) {
			edge.pinned ||= pinned;
			edge.reasons.push(reason);
			edge.sources.push(source);
		} else {
			merged.set(key, {
				from,
				to,
				reasons: [reason],
				pinned,
				sources: [source],
			});
		}
	}

	const edges = [...merged.values()]
		.map((e) => ({
			...e,
			reasons: uniqueSorted(e.reasons),
			sources: uniqueSorted(e.sources),
		}))
		.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));

	const dependents = new Map(ids.map((id) => [id, [] as string[]]));
	const dependencies = new Map(ids.map((id) => [id, [] as string[]]));
	for (const { from, to } of edges) {
		dependents.get(from)?.push(to);
		dependencies.get(to)?.push(from);
	}

	for (const list of dependencies.values()) {
		list.sort(compare);
	}

	const components = stronglyConnected(ids, dependencies);
	const warnings = components
		.filter((c) => c.length > 1)
		.map((c): Warning =>
			coreCodes.warning(
				"W_CYCLE",
				`dependency cycle: ${cyclePath(c, dependents).join(" -> ")}`,
			),
		);

	return {
		edges,
		dependents,
		dependencies,
		order: components.flat(),
		warnings,
	};
};
