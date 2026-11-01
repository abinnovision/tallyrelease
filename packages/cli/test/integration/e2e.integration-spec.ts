import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { fakeForge, memoryRemote } from "./harness/fake-forge.js";
import { createRepo, git, removeTmpDirs, tmpDir } from "./harness/git-repo.js";
import { runCli } from "./harness/run-cli.js";
import { affectedDocSchema } from "../../src/affected-schema.js";
import { planSchema } from "../../src/plan-schema.js";

import type { Dag } from "@tallyrelease/core/testing";

const json = (value: unknown) => JSON.stringify(value);

/** Affected `[id, reason]` pairs at HEAD for `--base <sha>`. */
const affectedAt = async (cwd: string, base: string) => {
	const result = await runCli(["affected", "--json", "--base", base], { cwd });
	expect(result).toMatchObject({ code: 0 });

	return affectedDocSchema
		.parse(JSON.parse(result.stdout))
		.units.map((u) => [u.path, u.reason]);
};

afterAll(removeTmpDirs);

describe("e2e", () => {
	it("yarn monorepo (G10)", async () => {
		const dag: Dag = {
			commits: [
				{
					id: "c0",
					files: {
						"tallyrelease.yaml": "plugins:\n  node: {}\n",
						"package.json": json({
							private: true,
							workspaces: ["packages/*", "apps/*"],
						}),
						"yarn.lock": "0",
						"README.md": "0",
						"packages/ui/package.json": json({ name: "@acme/ui" }),
						"packages/ui/src/button.ts": "0",
						"apps/web/package.json": json({
							name: "@acme/web",
							dependencies: { "@acme/ui": "workspace:^" },
						}),
						"apps/api/package.json": json({ name: "@acme/api" }),
						"apps/api/src/main.ts": "0",
					},
				},
				{ id: "c1", files: { "yarn.lock": "1" } },
				{ id: "c2", files: { "apps/api/src/main.ts": "2" } },
				{ id: "c3", files: { "packages/ui/src/button.ts": "3" } },
				{ id: "c4", files: { "README.md": "4" } },
			],
		};
		const { dir, sha } = createRepo(dag);

		expect(await affectedAt(dir, sha("c3"))).toEqual([]);
		expect(await affectedAt(dir, sha("c2"))).toEqual([
			["packages/ui", "direct"],
			["apps/web", "dependent"],
		]);
		expect(await affectedAt(dir, sha("c1"))).toEqual([
			["apps/api", "direct"],
			["packages/ui", "direct"],
			["apps/web", "dependent"],
		]);
		expect(await affectedAt(dir, sha("c0"))).toEqual([
			["apps/api", "global"],
			["packages/ui", "global"],
			["apps/web", "global"],
		]);

		const graph = await runCli(["graph", "--json"], { cwd: dir });
		expect(JSON.parse(graph.stdout)).toMatchObject({
			edges: [{ from: "ui", to: "web", pinned: false }],
		});
	});

	it("dart pub workspace (G40)", async () => {
		const app = (name: string, eol: string) =>
			[
				`name: ${name}`,
				"publish_to: none",
				"version: 1.0.0+7",
				"resolution: workspace",
				"dependencies:",
				"  shared: ^1.0.0",
				"",
			].join(eol);
		const { dir, sha } = createRepo({
			commits: [
				{
					id: "c0",
					files: {
						"tallyrelease.yaml": [
							"plugins: { dart: {} }",
							"units:",
							"  apps/a: { release: true }",
							"  apps/b: { release: true }",
							"branches:",
							"  - { name: main, line: default }",
							"",
						].join("\n"),
						"pubspec.yaml":
							"name: _workspace\npublish_to: none\nenvironment:\n  sdk: ^3.6.0\nworkspace:\n  - apps/a\n  - apps/b\n  - packages/shared\n",
						"packages/shared/pubspec.yaml":
							"name: shared\nversion: 1.0.0\nresolution: workspace\n",
						"packages/shared/lib/shared.dart": "0",
						"apps/a/pubspec.yaml": app("a", "\n"),
						"apps/b/pubspec.yaml": app("b", "\r\n"),
						"analysis_options.yaml": "0",
						"melos.yaml": "0",
					},
				},
				{
					id: "c1",
					message: "fix: shared bug",
					files: { "packages/shared/lib/shared.dart": "1" },
				},
				{
					id: "c2",
					message: "chore: lint",
					files: { "analysis_options.yaml": "2" },
				},
				{ id: "c3", message: "chore: melos", files: { "melos.yaml": "3" } },
			],
			tags: [
				{ name: "a-v1.0.0", commit: "c0" },
				{ name: "b-v1.0.0", commit: "c0" },
			],
		});

		const all = [
			["apps/a", "global"],
			["apps/b", "global"],
			["packages/shared", "global"],
		];
		git(dir, "checkout", "--quiet", sha("c2"));
		expect(await affectedAt(dir, sha("c1"))).toEqual(all);
		// main is at c3; version needs a branch.
		git(dir, "checkout", "--quiet", "main");
		expect(await affectedAt(dir, sha("c2"))).toEqual(all);

		const graph = await runCli(["graph", "--json"], { cwd: dir });
		const doc = JSON.parse(graph.stdout) as { units: { id: string }[] };
		expect(doc.units.map((u) => u.id).sort()).toEqual(["a", "b", "shared"]);
		expect(doc).toMatchObject({
			edges: [
				{ from: "shared", to: "a", pinned: false },
				{ from: "shared", to: "b", pinned: false },
			],
		});

		const plan = await runCli(["plan", "--json", "--base", sha("c0")], {
			cwd: dir,
		});
		expect(planSchema.parse(JSON.parse(plan.stdout)).units).toMatchObject([
			{ id: "shared", bump: null, next: null },
			{ id: "a", bump: "patch", next: "1.0.1", absorbedFrom: ["shared"] },
			{ id: "b", bump: "patch", next: "1.0.1", absorbedFrom: ["shared"] },
		]);

		const version = await runCli(["version"], { cwd: dir });
		expect(version).toMatchObject({ code: 0 });
		expect(readFileSync(join(dir, "apps/a/pubspec.yaml"), "utf8")).toBe(
			app("a", "\n").replace("1.0.0+7", "1.0.1"),
		);
		expect(readFileSync(join(dir, "apps/b/pubspec.yaml"), "utf8")).toBe(
			app("b", "\r\n").replace("1.0.0+7", "1.0.1"),
		);
	});

	it("php single repo (G11)", async () => {
		const { dir, sha } = createRepo(
			{
				commits: [
					{
						id: "c0",
						files: {
							"tallyrelease.yaml": "plugins:\n  php: {}\n",
							"composer.json": json({ name: "acme/php-app" }),
							"composer.lock": "0",
							"src/App.php": "0",
						},
					},
					{ id: "c1", files: { "composer.lock": "1" } },
					{ id: "c2", files: { "src/App.php": "2" } },
				],
			},
			"php-app",
		);

		expect(await affectedAt(dir, sha("c1"))).toEqual([[".", "direct"]]);
		expect(await affectedAt(dir, sha("c0"))).toEqual([[".", "global"]]);

		const check = await runCli(["graph"], { cwd: dir });
		expect(check.stdout).toBe(
			[
				"UNIT     PATH  PLUGIN  RELEASE",
				"php-app  .     php     -",
				"",
				"1 unit (0 released), 0 edges",
				"",
			].join("\n"),
		);

		git(dir, "remote", "add", "origin", "git@github.com:acme/widgets.git");
		const named = await runCli(["graph"], { cwd: dir });
		expect(named.stdout).toContain("\nwidgets  .     php     -\n");
	});

	it("rejects --cwd below the repository root", async () => {
		const { dir } = createRepo({
			commits: [
				{
					id: "c0",
					files: { "tallyrelease.yaml": "plugins: {}\n", "sub/x": "0" },
				},
			],
		});

		const result = await runCli(["check", "--cwd", "sub"], { cwd: dir });
		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(/^error\[E_NOT_REPO_ROOT\]: /);
	});

	it("rejects a missing directory and a non-repository", async () => {
		const { dir } = createRepo({
			commits: [{ id: "c0", files: { "tallyrelease.yaml": "plugins: {}\n" } }],
		});

		const missing = await runCli(["check", "--cwd", "nope"], { cwd: dir });
		expect(missing.code).toBe(1);
		expect(missing.stderr).toMatch(/^error\[E_CWD_MISSING\]: /);

		const plain = tmpDir("plain");
		writeFileSync(join(plain, "tallyrelease.yaml"), "plugins: {}\n");
		const result = await runCli(["affected"], { cwd: plain });
		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(/^error\[E_NOT_A_REPO\]: /);
	});

	it("plans the cwd repo under a surrounding hook's GIT_DIR", async () => {
		const { dir, sha } = createRepo({
			commits: [
				{
					id: "c0",
					files: {
						"tallyrelease.yaml": "units:\n  .: { id: app, release: true }\n",
						"a.ts": "0",
					},
				},
				{ id: "c1", message: "feat: a", files: { "a.ts": "1" } },
			],
		});
		const hook = {
			GIT_DIR: "/elsewhere",
			GIT_WORK_TREE: "/elsewhere",
			GIT_INDEX_FILE: "/elsewhere/index",
		};
		for (const [key, value] of Object.entries(hook)) {
			vi.stubEnv(key, value);
		}

		try {
			const result = await runCli(
				["plan", "--json", "--all", "--head", sha("c1")],
				{ cwd: dir, env: hook },
			);
			expect(result).toMatchObject({ code: 0 });
			const doc = planSchema.parse(JSON.parse(result.stdout));
			expect(doc.head).toBe(sha("c1"));
			expect(doc.units.map((u) => [u.id, u.next])).toEqual([["app", "1.0.0"]]);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("releases a manifest-less config-only unit (C23)", async () => {
		const { dir } = createRepo({
			commits: [
				{
					id: "c0",
					files: {
						"tallyrelease.yaml": [
							"branches:",
							"  - { name: main, line: default }",
							"units:",
							"  tools/setup:",
							"    release: true",
							"    versionFiles:",
							'      - { file: docs/install.md, pattern: "setup@{version}" }',
							"      - { file: tools/setup/env.sh }",
							"",
						].join("\n"),
						"docs/install.md": "Run `npx setup@1.0.0`.\n",
						"tools/setup/env.sh": "VERSION=1.0.0 # x-tallyrelease-version\n",
						"tools/setup/run.sh": "0",
					},
				},
				{
					id: "c1",
					message: "feat: add setup",
					files: { "tools/setup/run.sh": "1" },
				},
			],
			tags: [{ name: "setup-v1.0.0", commit: "c0" }],
		});
		const origin = tmpDir("origin.git");
		git(origin, "init", "--quiet", "--bare");
		git(dir, "remote", "add", "origin", origin);
		git(dir, "push", "--quiet", "origin", "main");

		const remote = memoryRemote();
		remote.branches.set("main", git(dir, "rev-parse", "HEAD"));
		const forge = fakeForge([], remote);
		const env = {
			GITHUB_TOKEN: "t",
			GITHUB_SERVER_URL: "https://github.com",
			GITHUB_REPOSITORY: "acme/repo",
		};
		const pr = await runCli(["pr"], { cwd: dir, forge, env });
		expect(pr).toMatchObject({ code: 0 });

		git(dir, "fetch", "--quiet", "origin", "tallyrelease/release/main/shared");
		const headSha = git(dir, "rev-parse", "FETCH_HEAD");
		git(dir, "merge", "--squash", "--quiet", "FETCH_HEAD");
		git(
			dir,
			"-c",
			"user.name=T",
			"-c",
			"user.email=t@example.com",
			"commit",
			"--quiet",
			"-m",
			"chore(release): setup (#1)",
		);
		const merge = git(dir, "rev-parse", "HEAD");
		git(dir, "push", "--quiet", "origin", "main");
		Object.assign(remote.prs[0] ?? {}, {
			headSha,
			state: "closed",
			mergedAt: "2025-01-01T00:00:00Z",
			mergeCommitSha: merge,
		});

		const release = await runCli(["release"], { cwd: dir, forge, env });
		expect(release).toMatchObject({ code: 0 });

		expect(git(dir, "rev-parse", "setup-v1.1.0^{commit}")).toBe(merge);
		expect(git(origin, "tag", "--list")).toBe("setup-v1.1.0");
		expect(git(dir, "show", "HEAD:tools/setup/CHANGELOG.md")).toContain(
			"add setup",
		);
		expect(git(dir, "show", "HEAD:docs/install.md")).toBe(
			"Run `npx setup@1.1.0`.",
		);
		expect(git(dir, "show", "HEAD:tools/setup/env.sh")).toBe(
			"VERSION=1.1.0 # x-tallyrelease-version",
		);
	});
});
