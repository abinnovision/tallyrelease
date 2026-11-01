import { memoryFs } from "@tallyrelease/core/testing";
import { describe, expect, it } from "vitest";

import { memoryRepo } from "./harness/memory-repo.js";
import { runCli } from "./harness/run-cli.js";

import type { DagTag } from "@tallyrelease/core/testing";

const check = (files: Record<string, string>, tags: DagTag[] = []) =>
	runCli(["check"], {
		fs: memoryFs(files),
		git: memoryRepo({ commits: [{ id: "c0" }], tags }).git,
	});

describe("check", () => {
	it("reports errors with exit code 1 (G12)", async () => {
		const ok = await check({
			"tallyrelease.yaml":
				"units:\n  a: {}\n  b: {}\ndeps:\n  - { from: a, to: b }\n",
			"a/x": "",
			"b/x": "",
		});
		expect(ok).toEqual({
			code: 0,
			stdout: "ok: 2 units (0 released), 1 edge\n",
			stderr: "",
		});

		const cases: [Record<string, string>, string][] = [
			[{}, "E_CONFIG_MISSING"],
			[{ "tallyrelease.yaml": "plugins: [" }, "E_CONFIG"],
			[{ "tallyrelease.yaml": "plugins: {}\nnope: []\n" }, "E_CONFIG"],
			[{ "tallyrelease.yaml": "plugins: { nope: {} }\n" }, "E_PLUGIN_UNKNOWN"],
			[
				{
					"tallyrelease.yaml":
						"units:\n  a: {}\ndeps:\n  - { from: a, to: b }\n",
					"a/x": "",
				},
				"E_EDGE_UNKNOWN_UNIT",
			],
			[
				{
					"tallyrelease.yaml": "units:\n  shared: { release: true }\n",
					"shared/x": "",
				},
				"E_RELEASE_ITEM_NAME",
			],
			[
				{
					"tallyrelease.yaml":
						"defaults: { release: true, releasePr: separate }\nunits:\n  a: {}\n  b: {}\ndeps:\n  - { from: a, to: b, pinned: true }\n",
					"a/x": "",
					"b/x": "",
				},
				"E_RELEASE_PR_SPLIT_EDGE",
			],
			[
				{
					"tallyrelease.yaml":
						"plugins: { node: {} }\nunits:\n  .: { release: true, versionFiles: [{ file: package.json, pattern: 'x@{version}' }] }\n",
					"package.json": "{}",
				},
				"E_VERSION_FILE_CLAIM",
			],
		];
		for (const [files, code] of cases) {
			// eslint-disable-next-line no-await-in-loop -- sequential cases
			const result = await check(files);
			expect(result.code).toBe(1);
			expect(result.stderr).toMatch(new RegExp(`^error\\[${code}\\]: `));
		}
	});

	it("names a malformed plugin manifest (C33-plugin-manifest-invalid)", async () => {
		const cases: [Record<string, string>, string][] = [
			[
				{
					"tallyrelease.yaml": "plugins: { node: {} }\n",
					"package.json": '{ "workspaces": ["packages/*"] }',
					"packages/a/package.json": '{ "name": ',
				},
				"packages/a/package.json",
			],
			[
				{
					"tallyrelease.yaml": "plugins: { php: {} }\n",
					"composer.json": "{ name",
				},
				"composer.json",
			],
		];
		for (const [files, path] of cases) {
			// eslint-disable-next-line no-await-in-loop -- sequential cases
			const result = await check(files);
			expect(result.code).toBe(1);
			expect(result.stderr).toMatch(
				new RegExp(`^error\\[E_PLUGIN_HOOK\\]: .*invalid JSON in ${path}: `),
			);
		}
	});

	it("rejects version none with a hint (G17)", async () => {
		const result = await check({
			"tallyrelease.yaml": "units:\n  a: { version: none }\n",
			"a/x": "",
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(
			/^error\[E_CONFIG\]: .*units\.a\.version: .*use release: false/,
		);
	});

	it("lists released units (G18)", async () => {
		const result = await check({
			"tallyrelease.yaml":
				"defaults: { release: true }\nunits:\n  b: {}\n  a: {}\n  c: { release: false }\n",
			"a/x": "",
			"b/x": "",
			"c/x": "",
		});
		expect(result).toEqual({
			code: 0,
			stdout: "ok: 3 units (2 released: a, b), 0 edges\n",
			stderr: "",
		});

		const none = await check({
			"tallyrelease.yaml": "units:\n  a: { version: file }\n",
			"a/x": "",
		});
		expect(none.stdout).toBe("ok: 1 unit (0 released), 0 edges\n");
	});

	it("validates release config and tags (G32)", async () => {
		const units = "units:\n  a: { release: true }\n  b: { release: true }\n";
		const files = { "a/x": "", "b/x": "" };
		const cases: [string, string][] = [
			["defaults: { tagFormat: 'v{version}' }\n", "E_TAG_FORMAT_OVERLAP"],
			[
				"branches:\n  - { name: main, line: default, channel: beta }\n  - { name: next, line: default, channel: beta }\n",
				"E_CHANNEL_DUPLICATE",
			],
		];
		for (const [config, code] of cases) {
			// eslint-disable-next-line no-await-in-loop -- sequential cases
			const result = await check({
				...files,
				"tallyrelease.yaml": `${units}${config}`,
			});
			expect(result.code).toBe(1);
			expect(result.stderr).toMatch(new RegExp(`^error\\[${code}\\]: `));
		}

		const result = await check({ ...files, "tallyrelease.yaml": units }, [
			{ name: "a-1.0.0", commit: "c0" },
			{ name: "b-v1.0.0", commit: "c0" },
		]);
		expect(result).toEqual({
			code: 0,
			stdout: "ok: 2 units (2 released: a, b), 0 edges\n",
			stderr:
				'warning[W_NO_MATCHING_TAG]: released unit "a" has no tag matching "a-v{version}", but "a-1.0.0" contains its id\n',
		});
	});

	it("runs the plugins' validate hooks on the plan", async () => {
		const run = async (validate: () => string[], argv: string[] = []) =>
			await runCli(["check", ...argv], {
				...memoryRepo({
					commits: [
						{
							id: "c0",
							files: {
								"tallyrelease.yaml": "plugins:\n  stub: { path: stub.ts }\n",
								"app/x": "",
							},
						},
					],
				}),
				importPlugin: () =>
					Promise.resolve({
						apiVersion: 1,
						name: "stub",
						discover: () => [{ id: "app", root: "app" }],
						validate,
					}),
			});

		expect(await run(() => ["careful"])).toEqual({
			code: 0,
			stdout: "ok: 1 unit (0 released), 0 edges\n",
			stderr: "warning[W_PLUGIN]: stub: careful\n",
		});
		expect((await run(() => ["careful"], ["--head", "c0"])).stderr).toBe(
			'warning[W_HEAD_BRANCH]: planning --head under the branch rule for "main"; pass --branch to choose\nwarning[W_PLUGIN]: stub: careful\n',
		);

		const failed = await run(() => {
			throw new Error("bad app");
		});
		expect(failed.code).toBe(1);
		expect(failed.stderr).toMatch(
			/^error\[E_PLUGIN_HOOK\]: plugin "stub" failed in validate: bad app/,
		);
	});

	it("reads --config relative to --cwd", async () => {
		const result = await runCli(
			["check", "--cwd", "sub", "--config", "conf/t.yaml"],
			{
				fs: memoryFs({ "conf/t.yaml": "plugins: {}\n" }),
				git: memoryRepo({ commits: [{ id: "c0" }] }).git,
			},
		);
		expect(result).toMatchObject({
			code: 0,
			stdout: "ok: 0 units (0 released), 0 edges\n",
		});
	});
});
