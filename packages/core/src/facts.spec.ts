import { describe, expect, it } from "vitest";

import { collectPlanFacts } from "./facts.js";
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
