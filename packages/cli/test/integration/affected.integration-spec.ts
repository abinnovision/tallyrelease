import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { fakeForge } from "./harness/fake-forge.js";
import { removeTmpDirs, tmpDir } from "./harness/git-repo.js";
import { memoryRepo } from "./harness/memory-repo.js";
import { actionsEnv, runCli } from "./harness/run-cli.js";
import { affectedDocSchema } from "../../src/affected-schema.js";
import { ForgeError } from "../../src/index.js";

import type { RunOptions } from "./harness/run-cli.js";
import type { Dag } from "@tallyrelease/core/testing";

const config = `
plugins: {}
units:
  libs/ui: { id: ui, release: true, tags: [npm] }
  apps/web: { id: web, tags: [docker] }
  apps/api: { id: api, tags: [docker] }
deps:
  - { from: ui, to: web }
`;

/** p0 - p1 (api) - p2 (ui) - p3 (api); x (ui) branches from p0 and is abandoned. */
const dag: Dag = {
	commits: [
		{
			id: "p0",
			files: {
				"tallyrelease.yaml": config,
				"libs/ui/a.ts": "0",
				"apps/web/a.ts": "0",
				"apps/api/a.ts": "0",
			},
		},
		{ id: "p1", files: { "apps/api/a.ts": "1" } },
		{ id: "x", parents: ["p0"], files: { "libs/ui/a.ts": "x" } },
		{ id: "p2", parents: ["p1"], files: { "libs/ui/a.ts": "2" } },
		{ id: "p3", files: { "apps/api/a.ts": "3" } },
	],
};

const push = (before: string) => ({ name: "push", payload: { before } });
const token = { ...actionsEnv, GITHUB_TOKEN: "t" };

const affected = async (args: string[], opts: RunOptions = {}) => {
	const result = await runCli(["affected", "--json", ...args], {
		...memoryRepo(dag),
		env: actionsEnv,
		...opts,
	});
	expect(result).toMatchObject({ code: 0 });
	const doc = affectedDocSchema.parse(JSON.parse(result.stdout));

	return {
		...result,
		doc,
		build: { base: doc.build.base, source: doc.build.baseSource },
		ids: doc.units.map((u) => u.id),
		warnings: doc.warnings.map((w) => w.code),
	};
};

afterAll(removeTmpDirs);

describe("affected", () => {
	it("push uses before (G01)", async () => {
		const noToken = await affected([], { event: push("p2") });
		expect(noToken.build).toEqual({ base: "p2", source: "push-before" });
		expect(noToken.ids).toEqual(["api"]);
		expect(noToken.warnings).toEqual(["W_NO_FORGE"]);
		expect(noToken.stderr).toContain("warning[W_NO_FORGE]: ");

		// A rerun after HEAD succeeded: lastSuccess is not an ancestor of before.
		const rerun = await affected([], {
			event: push("p2"),
			env: token,
			forge: fakeForge(["p3"]),
		});
		expect(rerun.build).toEqual({ base: "p2", source: "push-before" });
		expect(rerun.warnings).toEqual([]);
	});

	it("all-zero before falls back to the last successful run (G02)", async () => {
		const forge = fakeForge(["p1"]);
		const result = await affected([], {
			event: push("0".repeat(40)),
			env: token,
			forge,
		});
		expect(result.build).toEqual({ base: "p1", source: "forge-last-success" });
		expect(result.ids).toEqual(["api", "ui", "web"]);
		expect(forge.queries).toEqual([
			{
				owner: "acme",
				repo: "repo",
				workflow: "ci.yaml",
				branch: "main",
				page: 1,
			},
		]);
	});

	it("all-zero before without token builds everything (G03)", async () => {
		const result = await affected([], {
			event: push("0".repeat(40)),
			forge: fakeForge(["p1"]),
		});
		expect(result.build).toEqual({ base: null, source: "none" });
		expect(result.doc.build.all).toBe(true);
		expect(result.doc.units.map((u) => u.reason)).toEqual([
			"all",
			"all",
			"all",
		]);
		expect(result.warnings).toEqual(["W_NO_FORGE"]);
	});

	it("pull request uses the merge base (G04)", async () => {
		const pr: Dag = {
			commits: [
				dag.commits[0] ?? { id: "p0" },
				{ id: "p1", files: { "apps/api/a.ts": "1" } },
				{ id: "f1", parents: ["p0"], files: { "libs/ui/a.ts": "f" } },
			],
		};
		const result = await affected([], {
			...memoryRepo(pr),
			event: {
				name: "pull_request",
				payload: { pull_request: { base: { sha: "p1" } } },
			},
			env: { ...actionsEnv, GITHUB_HEAD_REF: "feature" },
		});
		expect(result.build).toEqual({ base: "p0", source: "pr-merge-base" });
		expect(result.doc.branch).toBe("feature");
		expect(result.ids).toEqual(["ui", "web"]);
		expect(result.doc.units[1]).toMatchObject({
			reason: "dependent",
			via: ["ui"],
		});
	});

	it("merge group uses base_sha (G05)", async () => {
		const result = await affected([], {
			event: {
				name: "merge_group",
				payload: { merge_group: { base_sha: "p2" } },
			},
		});
		expect(result.build).toEqual({ base: "p2", source: "merge-group" });
		expect(result.ids).toEqual(["api"]);
	});

	it("force push falls through to the last successful run (G06)", async () => {
		const withForge = await affected([], {
			event: push("x"),
			env: token,
			forge: fakeForge(["p2"]),
		});
		expect(withForge.build).toEqual({
			base: "p2",
			source: "forge-last-success",
		});

		const missing = await affected([], {
			event: push("f".repeat(40)),
			env: token,
			forge: fakeForge(["p2"]),
		});
		expect(missing.build).toEqual({ base: "p2", source: "forge-last-success" });

		const noToken = await affected([], { event: push("x") });
		expect(noToken.build).toEqual({ base: null, source: "none" });
		expect(noToken.warnings).toEqual(["W_NO_FORGE"]);
	});

	it("--base overrides the event (G08)", async () => {
		const result = await affected(["--base", "p1"], { event: push("p2") });
		expect(result.build).toEqual({ base: "p1", source: "cli" });
		expect(result.ids).toEqual(["api", "ui", "web"]);

		const unresolved = await runCli(["affected", "--base", "nope"], {
			...memoryRepo(dag),
		});
		expect(unresolved.code).toBe(1);
		expect(unresolved.stderr).toMatch(/^error\[E_BASE_UNRESOLVED\]: /);
	});

	it("writes $GITHUB_OUTPUT and --out (G09)", async () => {
		const dir = tmpDir("outputs");
		const output = join(dir, "github-output");
		const result = await affected(
			["--base", "p0", "--github-output", "--out", "affected.json"],
			{ env: { GITHUB_OUTPUT: output }, cwd: dir },
		);

		expect(
			affectedDocSchema.parse(
				JSON.parse(readFileSync(join(dir, "affected.json"), "utf8")),
			),
		).toEqual(result.doc);

		const lines = readFileSync(output, "utf8").split("\n");
		const delimiter = /^affected-paths<<(ghadelimiter_[\w-]+)$/.exec(
			lines[1] ?? "",
		)?.[1];
		expect(delimiter).toBeDefined();
		expect(lines).toEqual([
			'affected=[{"id":"api","path":"apps/api","plugin":"config","reason":"direct","released":false,"tags":["docker"]},{"id":"ui","path":"libs/ui","plugin":"config","reason":"direct","released":true,"tags":["npm"]},{"id":"web","path":"apps/web","plugin":"config","reason":"dependent","released":false,"tags":["docker"]}]',
			`affected-paths<<${delimiter ?? ""}`,
			"apps/api",
			"libs/ui",
			"apps/web",
			delimiter,
			"all=false",
			"base=p0",
			"base-source=cli",
			"",
		]);
	});

	it("--tag keeps units with any of the tags", async () => {
		const dir = tmpDir("tag");
		const output = join(dir, "github-output");
		const docker = await affected(
			["--base", "p1", "--tag", "docker", "--github-output"],
			{ env: { GITHUB_OUTPUT: output } },
		);
		expect(docker.ids).toEqual(["api", "web"]);
		expect(docker.doc.units[1]).toMatchObject({
			via: ["ui"],
			released: false,
			tags: ["docker"],
		});
		expect(docker.doc.build.all).toBe(false);

		const lines = readFileSync(output, "utf8").split("\n");
		expect(lines[0]).toBe(
			'affected=[{"id":"api","path":"apps/api","plugin":"config","reason":"direct","released":false,"tags":["docker"]},{"id":"web","path":"apps/web","plugin":"config","reason":"dependent","released":false,"tags":["docker"]}]',
		);
		expect(lines.slice(2, 4)).toEqual(["apps/api", "apps/web"]);

		const both = await affected([
			"--base",
			"p0",
			"--tag",
			"npm",
			"--tag",
			"docker",
		]);
		expect(both.ids).toEqual(["api", "ui", "web"]);

		const text = await runCli(
			["affected", "--base", "p2", "--tag", "docker"],
			memoryRepo(dag),
		);
		expect(text.stdout).toMatch(/\n1 of 2 units affected\n$/);

		const tsv = await runCli(
			[
				"affected",
				"--base",
				"p1",
				"--format",
				"tsv",
				"--tag",
				"npm",
				"--tag",
				"nope",
			],
			memoryRepo(dag),
		);
		expect(tsv).toEqual({
			code: 0,
			stdout:
				"id\tpath\treason\tvia\treleased\ttags\nui\tlibs/ui\tdirect\t\ttrue\tnpm\n",
			stderr: 'warning[W_TAG_UNKNOWN]: no unit has tag "nope"\n',
		});
	});

	it("a run cancelled while queued is covered by the last success (G13)", async () => {
		// p1 succeeded, the run of p2 was cancelled, this run is for p3.
		const result = await affected([], {
			event: push("p2"),
			env: token,
			forge: fakeForge(["p1"]),
		});
		expect(result.build).toEqual({ base: "p1", source: "forge-last-success" });
		expect(result.ids).toEqual(["api", "ui", "web"]);
	});

	it("uses a last success equal to before", async () => {
		const result = await affected([], {
			event: push("p2"),
			env: token,
			forge: fakeForge(["p2"]),
		});
		expect(result.build).toEqual({ base: "p2", source: "forge-last-success" });
	});

	it("skips forge candidates that are not ancestors of HEAD", async () => {
		const result = await affected([], {
			event: push("p2"),
			env: token,
			forge: fakeForge(["x", "p1"]),
		});
		expect(result.build).toEqual({ base: "p1", source: "forge-last-success" });
	});

	it.each(["workflow_dispatch", "schedule"])(
		"%s uses the last successful run",
		async (name) => {
			const event = { name, payload: {} };
			const withForge = await affected([], {
				event,
				env: token,
				forge: fakeForge(["p1"]),
			});
			expect(withForge.build).toEqual({
				base: "p1",
				source: "forge-last-success",
			});

			const noToken = await affected([], { event });
			expect(noToken.build).toEqual({ base: null, source: "none" });
			expect(noToken.warnings).toEqual(["W_NO_FORGE"]);
		},
	);

	it("pull_request_target builds everything", async () => {
		const result = await affected([], {
			event: {
				name: "pull_request_target",
				payload: { pull_request: { base: { sha: "p1" } } },
			},
		});
		expect(result.build).toEqual({ base: null, source: "none" });
	});

	it("forge errors warn and count as no last success", async () => {
		const forge = {
			...fakeForge(),
			lastSuccessfulPushRuns: async () =>
				await Promise.reject(new ForgeError("Bad Gateway", 502)),
		};
		const result = await affected([], { event: push("p2"), env: token, forge });
		expect(result.build).toEqual({ base: "p2", source: "push-before" });
		expect(result.warnings).toEqual(["W_FORGE_ERROR"]);
		expect(result.stderr).toContain(
			"warning[W_FORGE_ERROR]: forge request failed (502)",
		);
	});

	it("warns without workflow context", async () => {
		const result = await affected([], {
			event: { name: "schedule", payload: {} },
			env: { GITHUB_REPOSITORY: "acme/repo", GITHUB_TOKEN: "t" },
			forge: fakeForge(["p1"]),
		});
		expect(result.build).toEqual({ base: null, source: "none" });
		expect(result.warnings).toEqual(["W_NO_WORKFLOW_CONTEXT"]);
	});

	it("token without a successful run uses before (G15)", async () => {
		const result = await affected([], {
			event: push("p2"),
			env: token,
			forge: fakeForge([]),
		});
		expect(result.build).toEqual({ base: "p2", source: "push-before" });
		expect(result.warnings).toEqual(["W_NO_LAST_SUCCESS"]);
	});
});

describe("affected with the kustomize plugin", () => {
	const gitops: Dag = {
		commits: [
			{
				id: "g0",
				files: {
					"tallyrelease.yaml": "plugins:\n  kustomize: {}\n",
					"k8s/base/backend/kustomization.yaml":
						"resources: [deployment.yaml]\n",
					"k8s/base/backend/deployment.yaml": "0",
					"k8s/applications/staging/kustomization.yaml":
						"resources: [../../base/backend]\npatches:\n  - path: patch.yaml\n",
					"k8s/applications/staging/patch.yaml": "0",
					"k8s/applications/production/kustomization.yaml":
						"resources: [../../base/backend]\n",
				},
			},
			{ id: "g1", files: { "k8s/base/backend/deployment.yaml": "1" } },
			{ id: "g2", files: { "k8s/applications/staging/patch.yaml": "2" } },
		],
	};
	const run = async (base: string) => {
		const result = await runCli(["affected", "--json", "--base", base], {
			...memoryRepo(gitops),
			env: actionsEnv,
		});
		expect(result).toMatchObject({ code: 0 });

		return affectedDocSchema.parse(JSON.parse(result.stdout)).units;
	};

	it("marks applications of a changed base as dependent", async () => {
		expect(await run("g0")).toMatchObject([
			{
				id: "k8s-applications-production",
				reason: "dependent",
				via: ["k8s-base-backend"],
			},
			{ id: "k8s-applications-staging", reason: "direct" },
			{ id: "k8s-base-backend", reason: "direct" },
		]);
	});

	it("marks only the changed application", async () => {
		expect((await run("g1")).map((u) => u.id)).toEqual([
			"k8s-applications-staging",
		]);
	});
});
