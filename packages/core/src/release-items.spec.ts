import { describe, expect, it } from "vitest";

import { computePlan } from "./plan.js";
import { cutEquals, releaseEntries, releaseItems } from "./release-items.js";
import { memoryFs, memoryGit } from "./testing/index.js";
import { loadWorkspace } from "./workspace.js";

describe("cutEquals", () => {
	it("fails when the line's cut channel changed", async () => {
		const git = memoryGit({
			commits: [
				{ id: "c0", files: { "a/x": "0" } },
				{ id: "c1", message: "feat: a", files: { "a/x": "1" } },
			],
			tags: [{ name: "a-v1.0.0", commit: "c0" }],
		});
		const fs = memoryFs(git.tree("c1"));
		const workspace = await loadWorkspace({
			config: {
				plugins: {},
				units: { a: { release: true } },
				branches: [
					{ name: "main", line: "default", channels: { cut: "beta" } },
				],
			},
			plugins: [],
			fs,
			repo: { name: "demo" },
		});
		const plan = await computePlan(workspace, git, {
			tool: "test",
			branch: "main",
			head: "c1",
			base: "c0",
			baseSource: "cli",
			fs,
			all: true,
		});
		const marker = releaseEntries(releaseItems(workspace, plan, { cut: true }));
		const atH = { workspace, plan };
		const line = plan.line && { ...plan.line, cut: "rc" };

		expect(cutEquals(marker, atH, atH)).toBe(true);
		expect(cutEquals(marker, atH, { workspace, plan: { ...plan, line } })).toBe(
			false,
		);
	});
});
