import { afterAll, describe, expect, it } from "vitest";

import { createRepo, removeTmpDirs } from "./harness/git-repo.js";
import { memoryRepo } from "./harness/memory-repo.js";
import { runCli } from "./harness/run-cli.js";

import type { RunOptions } from "./harness/run-cli.js";
import type { Dag } from "@tallyrelease/core/testing";

afterAll(removeTmpDirs);

const plugin = `import { units } from "./units.ts";

export default {
	apiVersion: 1,
	name: "local",
	discover: (ctx) => units(ctx.options.root),
};
`;

describe("plugins", () => {
	it("activates a local plugin by its config name", async () => {
		const { dir } = createRepo({
			commits: [
				{
					id: "c0",
					files: {
						"tallyrelease.yaml":
							"plugins:\n  local: { path: tools/plugin.ts, root: app }\n",
						"tools/plugin.ts": plugin,
						"tools/units.ts":
							"export const units = (root: string) => [{ id: root, root }];\n",
						"app/x": "",
					},
				},
			],
		});

		const graph = await runCli(["graph", "--json"], { cwd: dir });
		expect(graph).toMatchObject({ code: 0, stderr: "" });
		expect(JSON.parse(graph.stdout)).toMatchObject({
			units: [{ id: "app", path: "app", plugin: "local" }],
		});
	});

	it("loads plugin packages from the repo's node_modules", async () => {
		const pkg = (name: string, apiVersion: number) => ({
			[`node_modules/@acme/${name}/package.json`]: JSON.stringify({
				name: `@acme/${name}`,
				type: "module",
				exports: { ".": "./index.js" },
			}),
			[`node_modules/@acme/${name}/index.js`]: `export default { apiVersion: ${String(apiVersion)}, name: "${name}", discover: () => [{ id: "app", root: "app" }] };\n`,
		});
		const { dir } = createRepo({
			commits: [
				{
					id: "c0",
					files: {
						"tallyrelease.yaml": "plugins:\n  x: { package: '@acme/x' }\n",
						"v2.yaml": "plugins:\n  v2: { package: '@acme/v2' }\n",
						...pkg("x", 1),
						...pkg("v2", 2),
						"app/x": "",
					},
				},
			],
		});

		const graph = await runCli(["graph", "--json"], { cwd: dir });
		expect(graph).toMatchObject({ code: 0, stderr: "" });
		expect(JSON.parse(graph.stdout)).toMatchObject({
			units: [{ id: "app", plugin: "x" }],
		});

		const v2 = await runCli(["check", "--config", "v2.yaml"], { cwd: dir });
		expect(v2.code).toBe(1);
		expect(v2.stderr).toContain("error[E_PLUGIN_API]");
	});

	it("fails with E_PLUGIN_LOAD when the file is missing", async () => {
		const { dir } = createRepo({
			commits: [
				{
					id: "c0",
					files: {
						"tallyrelease.yaml": "plugins:\n  local: { path: nope.ts }\n",
					},
				},
			],
		});

		const result = await runCli(["check"], { cwd: dir });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			'error[E_PLUGIN_LOAD]: plugin "local": cannot load "nope.ts"',
		);
	});
});

describe("local plugins in privileged commands", () => {
	const dag: Dag = {
		commits: [
			{
				id: "c0",
				files: {
					"tallyrelease.yaml":
						"plugins:\n  local: { path: tools/plugin.ts }\nbranches:\n  - { name: main, line: default }\n",
					"app/x": "",
				},
			},
		],
	};

	const run = async (argv: string[], opts: RunOptions = {}) => {
		const imported: string[] = [];
		const result = await runCli(argv, {
			...memoryRepo(dag),
			importPlugin: (specifier) => {
				imported.push(specifier);

				return Promise.resolve({
					apiVersion: 1,
					name: "local",
					discover: () => [{ id: "app", root: "app" }],
				});
			},
			...opts,
		});

		return { ...result, imported };
	};

	it("load only when allowed", async () => {
		const denied = await run(["version", "--dry-run"]);
		expect(denied).toMatchObject({ code: 1, imported: [] });
		expect(denied.stderr).toContain(
			'error[E_PLUGIN_LOCAL]: plugin "local": privileged commands load local plugins only with --allow-local-plugins',
		);

		expect(
			await run(["version", "--dry-run", "--allow-local-plugins"]),
		).toMatchObject({ code: 0, imported: ["./tools/plugin.ts"] });
		expect(
			await run(["version", "--dry-run"], {
				env: { TALLYRELEASE_ALLOW_LOCAL_PLUGINS: "true" },
			}),
		).toMatchObject({ code: 0, imported: ["./tools/plugin.ts"] });
		expect(
			await run(["version", "--dry-run"], {
				env: { TALLYRELEASE_ALLOW_LOCAL_PLUGINS: "false" },
			}),
		).toMatchObject({ code: 1, imported: [] });
	});

	it("load in non-privileged commands without the flag", async () => {
		expect(await run(["check"])).toMatchObject({
			code: 0,
			imported: ["./tools/plugin.ts"],
		});
	});

	// pull_request_target skips the effect; a review event reaches the gate.
	it.each([
		["pull_request_target", "refs/heads/main", 0, ""],
		["pull_request_review", "refs/pull/7/merge", 1, "E_PLUGIN_LOCAL"],
	])(
		"never run the head's plugin of a fork PR on %s",
		async (name, ref, code, error) => {
			const result = await run(["version", "--allow-local-plugins"], {
				env: { GITHUB_REF: ref },
				event: {
					name,
					payload: { pull_request: { head: { repo: { fork: true } } } },
				},
			});

			expect(result).toMatchObject({ code, imported: [] });
			expect(result.stderr).toContain(error);
		},
	);
});
