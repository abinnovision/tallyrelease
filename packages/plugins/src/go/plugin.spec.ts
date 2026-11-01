import { computePlan, loadWorkspace } from "@tallyrelease/core";
import { memoryCtx, memoryFs, memoryGit } from "@tallyrelease/core/testing";
import { describe, expect, it } from "vitest";

import { goPlugin } from "./plugin.js";

import type { Unit } from "@tallyrelease/core";

const unit = (id: string, root: string): Unit => ({
	id,
	root,
	plugin: "go",
	include: [],
	exclude: [],
	version: "tag",
	scheme: "semver",
	tagFormat: "",
	propagate: "auto",
	tags: [],
	initialVersion: null,
	meta: {},
});

describe("go plugin", () => {
	it("discovers modules with their path and tag format", async () => {
		const units = await goPlugin.discover?.(
			memoryCtx({
				repo: "mono",
				files: {
					"go.mod": "module example.com/mono\n\ngo 1.22\n",
					"mod/a/go.mod": '// c\nmodule "example.com/mono/mod/a" // x\n',
					"mod/a/main.go": "package a",
				},
			}),
		);
		expect(units).toEqual([
			{
				id: "mono",
				root: ".",
				version: "tag",
				tagFormat: "v{version}",
				meta: { modulePath: "example.com/mono" },
			},
			{
				id: "a",
				root: "mod/a",
				version: "tag",
				tagFormat: "mod/a/v{version}",
				meta: { modulePath: "example.com/mono/mod/a" },
			},
		]);
	});

	it("creates edges for relative replace directives only", async () => {
		const units = [unit("a", "mod/a"), unit("b", "mod/b"), unit("c", "lib/c")];
		const edges = await goPlugin.edges?.(
			memoryCtx({
				files: {
					"mod/a/go.mod": [
						"module example.com/a",
						"replace example.com/b v1.0.0 => ../b",
						"replace example.com/remote => example.com/fork v1.0.0",
						"replace (",
						'\texample.com/c => "../../lib/c" // local',
						"\texample.com/gone => ../../../outside",
						")",
					].join("\n"),
					"mod/b/go.mod": "module example.com/b\nreplace example.com/b => ./",
				},
			}),
			units,
		);
		expect(edges).toEqual([
			{ from: "b", to: "a", reason: "replace: example.com/b", pinned: false },
			{ from: "c", to: "a", reason: "replace: example.com/c", pinned: false },
		]);
	});

	describe("major version path", () => {
		/** Plans the root module released at `tag` plus one commit with `message`. */
		const plan = async (modulePath: string, tag: string, message: string) => {
			const git = memoryGit({
				commits: [
					{ id: "c0", files: { "go.mod": `module ${modulePath}\n` } },
					{ id: "c1", message, files: { "a.go": "1" } },
				],
				tags: [{ name: tag, commit: "c0" }],
			});
			const fs = memoryFs(git.tree("c1"));
			const workspace = await loadWorkspace({
				config: { plugins: { go: {} }, defaults: { release: true } },
				plugins: [goPlugin],
				fs,
				repo: { name: "mono" },
			});

			return await computePlan(workspace, git, {
				tool: "test",
				branch: "main",
				head: "c1",
				base: "c0",
				baseSource: "cli",
				fs,
				all: true,
			});
		};

		it("rejects next 2.0.0 without a /v2 path", async () => {
			await expect(
				plan("example.com/mono", "v1.2.3", "feat!: break"),
			).rejects.toMatchObject({
				code: "E_PLUGIN_HOOK",
				details: { plugin: "go", hook: "validate" },
				message: expect.stringContaining(
					'E_GO_MAJOR_PATH: unit "mono" releases 2.0.0 but module path "example.com/mono" must end in "/v2"',
				),
			});
		});

		it("rejects a /vN path that disagrees with next", async () => {
			await expect(
				plan("example.com/mono/v3", "v2.1.0", "feat: add"),
			).rejects.toMatchObject({
				message: expect.stringContaining(
					'module path "example.com/mono/v3" must end in "/v2"',
				),
			});
			await expect(
				plan("example.com/mono/v2", "v1.2.3", "fix: bug"),
			).rejects.toMatchObject({
				message: expect.stringContaining("must not end in a /vN suffix"),
			});
		});

		it("accepts matching paths", async () => {
			const v2 = await plan("example.com/mono/v2", "v2.1.0", "feat: add");
			expect(v2.units[0]?.next).toBe("2.2.0");
			const v1 = await plan("example.com/mono", "v1.2.3", "feat: add");
			expect(v1.units[0]?.next).toBe("1.3.0");
		});
	});
});
