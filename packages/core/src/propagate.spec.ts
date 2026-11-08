import { describe, expect, it } from "vitest";

import { propagate, releasedEdges } from "./propagate.js";

import type { EdgeKind } from "./plugin.js";

const release = {
	absorbedKinds: {
		default: ["runtime", "peer"] as EdgeKind[],
		units: new Map<string, EdgeKind[]>(),
	},
};

const edge = (
	from: string,
	to: string,
	kind: EdgeKind = "runtime",
	pinned = true,
) => ({
	from,
	to,
	reasons: ["dependencies"],
	pinned,
	kinds: [kind],
	sources: ["stub"],
});

describe("propagate", () => {
	it("terminates on a three-node pinned cycle", () => {
		const result = propagate(
			{
				graph: {
					edges: [edge("a", "b"), edge("b", "c"), edge("c", "a")],
					order: ["a", "b", "c"],
				},
				units: ["a", "b", "c"].map((id) => ({
					id,
					propagate: "auto" as const,
				})),
				release,
			},
			new Map([
				["a", { bump: "minor" as const, pending: true }],
				["b", { bump: null, pending: false }],
				["c", { bump: null, pending: false }],
			]),
		);

		expect(Object.fromEntries(result)).toEqual({
			a: { bump: "minor", pending: true, propagatedFrom: ["c"] },
			b: { bump: "patch", pending: true, propagatedFrom: ["a"] },
			c: { bump: "patch", pending: true, propagatedFrom: ["b"] },
		});
	});

	it("raises two groups that propagate into each other in a cycle", () => {
		const state = (group: string, bump: "minor" | null = null) => ({
			bump,
			pending: bump !== null,
			group,
		});
		const result = propagate(
			{
				graph: {
					edges: [edge("b", "c"), edge("d", "a")],
					order: ["a", "b", "c", "d"],
				},
				units: ["a", "b", "c", "d"].map((id) => ({
					id,
					propagate: "auto" as const,
				})),
				release,
			},
			new Map([
				["a", state("g1", "minor")],
				["b", state("g1")],
				["c", state("g2")],
				["d", state("g2")],
			]),
		);

		expect(
			Object.fromEntries(
				[...result].map(([id, s]) => [id, [s.bump, s.propagatedFrom]]),
			),
		).toEqual({
			a: ["minor", ["d"]],
			b: ["minor", []],
			c: ["patch", ["b"]],
			d: ["patch", []],
		});
	});

	it("drops a dev hop of a path but keeps a direct dev edge", () => {
		const released = new Set(["s", "r"]);
		const path = [edge("s", "u", "dev"), edge("u", "r")];

		expect(releasedEdges(path, released, release).size).toBe(0);
		expect(
			releasedEdges([...path, edge("s", "r", "dev")], released, release),
		).toEqual(new Map([["r", new Map([["s", true]])]]));
	});

	it("reaches a unit by a valid path after a rejected hop to it", () => {
		const edges = [
			edge("s", "u1", "dev", false),
			edge("s", "u2"),
			edge("u2", "u1"),
			edge("u1", "r"),
		];

		expect(releasedEdges(edges, new Set(["s", "r"]), release)).toEqual(
			new Map([["r", new Map([["s", true]])]]),
		);
	});
});
