import { describe, expect, it } from "vitest";

import { maintenanceCut } from "./branches.js";
import { computePlan } from "./plan.js";
import { releaseItems } from "./release-items.js";
import { memoryFs, memoryGit } from "./testing/index.js";
import { loadWorkspace } from "./workspace.js";

import type { BranchConfig, TallyConfig } from "./config.js";

/** Cuts by item name; `a` at 2.3.4 and `b` at 2.3.1, one commit on both. */
const cuts = async (
	branches: BranchConfig[],
	opts: {
		message?: string;
		branch?: string;
		tags?: string[];
		groups?: TallyConfig["groups"];
	} = {},
) => {
	const {
		message = "feat!: break",
		branch = "main",
		tags = ["a-v2.3.4", "b-v2.3.1"],
		groups,
	} = opts;
	const git = memoryGit({
		commits: [
			{ id: "c0", files: { "a/x": "0", "b/x": "0" } },
			{ id: "c1", message, files: { "a/x": "1", "b/x": "1" } },
		],
		tags: tags.map((name) => ({ name, commit: "c0" })),
	});
	const fs = memoryFs(git.tree("c1"));
	const workspace = await loadWorkspace({
		config: {
			plugins: {},
			units: { a: { release: true }, b: { release: true } },
			branches: [{ name: "main", line: "default" }, ...branches],
			...(groups && { groups }),
		},
		plugins: [],
		fs,
		repo: { name: "demo" },
	});
	const plan = await computePlan(workspace, git, {
		tool: "test",
		branch,
		head: "c1",
		base: "c0",
		baseSource: "cli",
		fs,
		all: true,
	});

	return Object.fromEntries(
		releaseItems(workspace, plan).map((i) => [
			i.name,
			maintenanceCut(workspace, plan, i),
		]),
	);
};

describe("maintenanceCut", () => {
	it("uses the unit's rule and base tag, skipping rules for other units", async () => {
		expect(
			await cuts([
				{ name: "b/{major}.x", line: "maintenance", unit: "b" },
				{ name: "a/{major}.x", line: "maintenance", unit: "a" },
			]),
		).toEqual({
			a: { branch: "a/2.x", tag: "a-v2.3.4", line: "2.x" },
			b: { branch: "b/2.x", tag: "b-v2.3.1", line: "2.x" },
		});
	});

	it("uses an untargeted rule and renders {minor}", async () => {
		expect(
			(
				await cuts([
					{ name: "release/*", line: "maintenance" },
					{ name: "release/{major}.{minor}.x", line: "maintenance" },
				])
			)["a"],
		).toEqual({ branch: "release/2.3.x", tag: "a-v2.3.4", line: "2.3.x" });
	});

	it("uses the group base tag for a group", async () => {
		expect(
			await cuts(
				[{ name: "sdk/{major}.x", line: "maintenance", group: "sdk" }],
				{ groups: { sdk: { units: ["a", "b"] } } },
			),
		).toEqual({ sdk: { branch: "sdk/2.x", tag: "a-v2.3.4", line: "2.x" } });
	});

	it.each([
		["a minor bump", { message: "feat: add" }],
		["a first release", { tags: [] }],
		["a maintenance line", { branch: "hotfix/x" }],
	])("is undefined for %s", async (_, opts) => {
		expect(
			await cuts(
				[
					{ name: "release/{major}.x", line: "maintenance" },
					{ name: "hotfix/*", line: "maintenance" },
				],
				opts,
			),
		).toEqual({ a: undefined, b: undefined });
	});
});
