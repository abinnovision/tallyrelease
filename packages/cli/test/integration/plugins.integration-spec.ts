import { afterAll, describe, expect, it } from "vitest";

import { createRepo, removeTmpDirs } from "./harness/git-repo.js";
import { runCli } from "./harness/run-cli.js";

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
