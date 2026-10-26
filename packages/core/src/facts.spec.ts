import { describe, expect, it } from "vitest";

import { collectPlanFacts, lineFacts, rangeFacts, tagFacts } from "./facts.js";
import { memoryFs, memoryGit } from "./testing/index.js";
import { loadWorkspace } from "./workspace.js";

import type { Change, IntentSource } from "./plugin.js";

const facts = async (collect: IntentSource["collect"]) => {
	const git = memoryGit({
		commits: [{ id: "c0", message: "fix: a", files: { "a/x.ts": "0" } }],
	});
	const fs = memoryFs(git.tree("c0"));
	const workspace = await loadWorkspace({
		config: { plugins: { stub: {} }, units: { a: { id: "a", release: true } } },
		plugins: [
			{ apiVersion: 1, name: "stub", intent: [{ name: "s", collect }] },
		],
		fs,
		repo: { name: "demo" },
	});

	return await collectPlanFacts(workspace, git, { head: "c0", fs });
};

describe("collectPlanFacts", () => {
	it("unions releaseAs into a deduped Change", async () => {
		const change: Change = {
			sha: "c0",
			type: "fix",
			breaking: false,
			subject: "a",
			releaseAs: [{ unit: "a", version: "2.0.0" }],
		};
		const result = await facts(() => [change]);
		expect(result.units[0]?.changes).toEqual([
			{
				change: expect.objectContaining({
					releaseAs: [{ unit: "a", version: "2.0.0" }],
				}),
				units: ["a"],
			},
		]);
		expect(result.units[0]?.releaseAs).toEqual([
			{ sha: "c0", version: "2.0.0" },
		]);
	});

	it("wraps a throwing intent source as E_PLUGIN_HOOK", async () => {
		await expect(
			facts(() => {
				throw new Error("boom");
			}),
		).rejects.toMatchObject({
			code: "E_PLUGIN_HOOK",
			details: { plugin: "stub", hook: "intent" },
		});
	});
});

describe("facts steps", () => {
	const git = memoryGit({
		commits: [
			{ id: "c0", message: "feat: a", files: { "a/x.ts": "0" } },
			{ id: "c1", message: "fix: a", files: { "a/x.ts": "1" } },
			{ id: "c2", message: "fix: a again", files: { "a/x.ts": "2" } },
		],
		tags: [{ name: "a-v1.0.0", commit: "c1" }],
	});
	const workspace = () =>
		loadWorkspace({
			config: {
				plugins: { stub: {} },
				units: { a: { id: "a", release: true } },
			},
			plugins: [
				{
					apiVersion: 1,
					name: "stub",
					intent: [
						{
							name: "s",
							collect: (_ctx, { commits }) =>
								commits.map((c) => ({
									sha: c.sha,
									type: "fix",
									breaking: false,
									subject: c.sha,
								})),
						},
					],
				},
			],
			fs: memoryFs(git.tree("c2")),
			repo: { name: "demo" },
		});

	it("lineFacts counts first-parent commits", async () => {
		const line = await lineFacts(git, "c2");
		expect(line.total).toBe(3);
		expect(await line.countSince("c0")).toBe(2);
		expect(await line.lineCount(".", null)).toEqual({
			introduced: null,
			sinceLineBase: 3,
		});
		expect(
			await line.lineCount("a", {
				name: "a-v1.0.0",
				sha: "c1",
				version: "1.0.0",
			}),
		).toEqual({ introduced: null, sinceLineBase: 1 });
		expect(await line.lineCount("a", null)).toEqual({
			introduced: "c0",
			sinceLineBase: 3,
		});
	});

	it("tagFacts resolves unit base tags", async () => {
		const result = await tagFacts(
			await workspace(),
			git,
			await lineFacts(git, "c2"),
		);
		expect(result.tagNames).toEqual(["a-v1.0.0"]);
		expect(result.bases.get("a")).toMatchObject({
			baseTag: { name: "a-v1.0.0", sha: "c1" },
			lineBaseTag: { name: "a-v1.0.0", sha: "c1" },
			sinceLineBase: 1,
		});
		expect(result.groups).toEqual([]);
		expect(await result.isAncestor("c0", "c2")).toBe(true);
	});

	it("rangeFacts attributes changes per range", async () => {
		const ranges = rangeFacts(await workspace(), git, {
			head: "c2",
			fs: memoryFs({}),
		});
		const since = await ranges.range("c1");
		expect(since.changes.map((c) => [c.change.sha, c.units])).toEqual([
			["c2", ["a"]],
		]);
		expect(await ranges.range("c1")).toBe(since);
		expect(ranges.all()).toEqual([since]);
	});
});
