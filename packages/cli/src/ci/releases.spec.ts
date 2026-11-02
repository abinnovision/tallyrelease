import { describe, expect, it } from "vitest";

import { releaseListEntries } from "./releases.js";

import type { Plan, Workspace } from "@tallyrelease/core";

const forge = {
	pr: { number: 1, url: "pull/1" },
	release: { url: "release/a-v1.0.0" },
};

const released = (id: string) => ({
	id,
	path: id,
	version: "1.0.0",
	tag: `${id}-v1.0.0`,
	floatingTags: [],
	releaseSha: "abc",
	catchUp: false,
	forge,
	line: "default" as const,
	latest: true,
});

const workspace = (
	units: { id: string; tagFormat?: string; tags?: string[] }[],
	groups: { name: string; members: string[] }[] = [],
) =>
	({
		units: units.map((u) => ({
			tagFormat: "{id}-v{version}",
			tags: [],
			...u,
		})),
		groups,
	}) as unknown as Workspace;

describe("releaseListEntries", () => {
	it("lists tags, group and forge of a release, and the unit's tags and group with a null forge for a prerelease", () => {
		const plan = {
			head: "def",
			line: null,
			released: ["a", "c"].map(released),
			units: [
				{
					id: "b",
					kind: "prerelease",
					version: "1.1.0-0",
					tags: ["web"],
					group: "g",
					changes: [],
					propagatedFrom: [],
				},
			],
		} as unknown as Plan;
		const entries = releaseListEntries(
			plan,
			workspace(
				[
					{ id: "a", tags: ["api", "node"] },
					{ id: "b", tags: ["web"] },
				],
				[{ name: "g", members: ["a", "b"] }],
			),
			new Map(),
		);

		expect(
			entries.map(({ id, tags, group, forge: f }) => ({
				id,
				tags,
				group,
				forge: f,
			})),
		).toEqual([
			{ id: "a", tags: ["api", "node"], group: "g", forge },
			{ id: "c", tags: [], group: null, forge },
			{ id: "b", tags: ["web"], group: "g", forge: null },
		]);
	});

	it("lists the changes at the release's parent, [] for a missing unit, and HEAD's for a prerelease", () => {
		const change = (subject: string) => ({
			type: "feat",
			breaking: false,
			subject,
		});
		const plan = {
			head: "def",
			line: null,
			released: ["a", "b"].map(released),
			units: [
				{
					id: "a",
					kind: "prerelease",
					version: "1.1.0-0",
					changes: [],
					propagatedFrom: [],
				},
				{
					id: "b",
					kind: "prerelease",
					version: "1.1.0-0",
					changes: [change("pending")],
					propagatedFrom: [],
				},
			],
		} as unknown as Plan;
		const atParent = new Map([
			["abc", [{ id: "a", changes: [change("released")], propagatedFrom: [] }]],
		]) as unknown as Map<string, Plan["units"]>;

		expect(
			releaseListEntries(plan, workspace([]), atParent).map((e) => e.changes),
		).toEqual([[change("released")], [], [], [change("pending")]]);
	});

	it("sets line on releases and prereleases", () => {
		const plan = (kind?: "maintenance") =>
			({
				head: "def",
				line: kind ? { kind } : null,
				released: [{ ...released("a"), line: kind ?? "default" }],
				units: [
					{
						id: "b",
						kind: "prerelease",
						version: "1.1.0-0",
						changes: [],
						propagatedFrom: [],
					},
				],
			}) as unknown as Plan;
		const lines = (p: Plan) =>
			releaseListEntries(p, workspace([]), new Map()).map((e) => e.line);

		expect(lines(plan())).toEqual(["default", "default"]);
		expect(lines(plan("maintenance"))).toEqual(["maintenance", "maintenance"]);
	});

	describe("propagated changes", () => {
		const change = (sha: string | undefined, via?: string) => ({
			type: "fix",
			breaking: false,
			subject: sha ?? "file",
			...(sha === undefined ? {} : { sha }),
			...(via === undefined ? {} : { via }),
		});
		const unit = (
			id: string,
			changes: ReturnType<typeof change>[],
			propagatedFrom: string[] = [],
		) => ({
			id,
			kind: "prerelease",
			version: "1.1.0-0",
			changes,
			propagatedFrom,
		});
		const subjects = (e: { changes: { subject: string; via?: string }[] }) =>
			e.changes.map((c) => [c.subject, c.via]);

		it("lists the changes of the units a release was propagated from", () => {
			const plan = { head: "def", line: null, released: [released("a")] };
			const atParent = new Map([
				[
					"abc",
					[
						unit("a", [change("a1")], ["b", "d"]),
						unit("b", [change("b1"), change("x1", "x")], ["c"]),
						unit("c", [change("c1")]),
						unit("d", [change("c1"), change("d1")], ["c"]),
					],
				],
			]) as unknown as Map<string, Plan["units"]>;
			const [entry] = releaseListEntries(
				{ ...plan, units: [] } as unknown as Plan,
				workspace([]),
				atParent,
			);

			expect(entry && subjects(entry)).toEqual([
				["a1", undefined],
				["b1", "b"],
				["x1", "x"],
				["c1", "c"],
				["d1", "d"],
			]);
		});

		it("terminates on a cycle and keeps sha-less changes", () => {
			const plan = {
				head: "def",
				line: null,
				released: [],
				units: [
					unit("a", [change(undefined)], ["b"]),
					unit("b", [change(undefined), change("b1")], ["a"]),
				],
			} as unknown as Plan;
			const [entry] = releaseListEntries(plan, workspace([]), new Map());

			expect(entry && subjects(entry)).toEqual([
				["file", undefined],
				["file", "b"],
				["b1", "b"],
			]);
		});
	});
});
