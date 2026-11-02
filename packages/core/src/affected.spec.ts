import { describe, expect, it } from "vitest";

import { computeAffected } from "./affected.js";
import { memoryFs, memoryGit } from "./testing/index.js";
import { loadWorkspace } from "./workspace.js";

import type { AttributionConfig } from "./config.js";
import type { GitReader } from "./plugin.js";

const repo = memoryGit({
	commits: [
		{ id: "c0", files: { "app/x": "0", "ci.yaml": "0" } },
		{ id: "c1", message: "fix(api): x", files: { "app/x": "1" } },
		{ id: "c2", message: "ci: y", files: { "ci.yaml": "2" } },
	],
});
const git: GitReader = {
	...repo,
	log: () => {
		throw new Error("unexpected log");
	},
};

const affected = async (
	base: string | null,
	head: string,
	attribution?: AttributionConfig,
) => {
	const workspace = await loadWorkspace({
		config: {
			plugins: {},
			units: { app: {} },
			globalInputs: ["ci.yaml"],
			...(attribution && { attribution }),
		},
		plugins: [],
		fs: memoryFs(repo.tree(head)),
		repo: { name: "demo" },
	});

	return await computeAffected(workspace, git, {
		tool: "test",
		branch: "main",
		head,
		base,
		baseSource: base === null ? "none" : "cli",
	});
};

const scoped = { scopes: { api: ["app"] } };

describe("computeAffected", () => {
	it("reads no log without scopes", async () => {
		expect((await affected("c0", "c1")).units).toMatchObject([{ id: "app" }]);
	});

	it("reads no log without a base", async () => {
		expect((await affected(null, "c1", scoped)).build.all).toBe(true);
	});

	it("reads no log on a global hit", async () => {
		for (const attribution of [undefined, scoped]) {
			// eslint-disable-next-line no-await-in-loop -- one case per config
			const doc = await affected("c0", "c2", attribution);
			expect(doc.build).toMatchObject({ all: true, globalInputs: ["ci.yaml"] });
		}
	});
});
