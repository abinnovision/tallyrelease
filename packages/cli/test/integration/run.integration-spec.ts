import { memoryGit } from "@tallyrelease/core/testing";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
	fakeForge,
	fakeGitWriter,
	memoryRemote,
	mergePr,
} from "./harness/fake-forge.js";
import { removeTmpDirs, tmpDir } from "./harness/git-repo.js";
import { memoryRepo } from "./harness/memory-repo.js";
import { actionsEnv, runCli } from "./harness/run-cli.js";
import { planSchema, releaseEntrySchema } from "../../src/plan-schema.js";

import type { RunOptions } from "./harness/run-cli.js";
import type { Dag } from "@tallyrelease/core/testing";

afterAll(removeTmpDirs);

const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

const env = {
	...actionsEnv,
	GITHUB_TOKEN: "t",
	GITHUB_SERVER_URL: "https://github.com",
};

const config = `
plugins: { node: {} }
defaults: { release: true }
branches:
  - { name: main, line: default }
# Warns W_GROUP_EMPTY in every plan.
groups:
  empty: { tags: [none] }
`;

/** Units a and b at 1.0.0 (tagged at c0), one feat on each. */
const dag: Dag = {
	commits: [
		{
			id: "c0",
			files: {
				"tallyrelease.yaml": config,
				"package.json": json({ workspaces: ["packages/*"] }),
				"packages/a/package.json": json({ name: "@s/a", version: "1.0.0" }),
				"packages/b/package.json": json({ name: "@s/b", version: "1.0.0" }),
			},
		},
		{ id: "c1", message: "feat(a): add a", files: { "packages/a/x.ts": "1" } },
		{ id: "c2", message: "feat(b): add b", files: { "packages/b/x.ts": "1" } },
	],
	tags: [
		{ name: "a-v1.0.0", commit: "c0" },
		{ name: "b-v1.0.0", commit: "c0" },
	],
};

const commit = (before: Dag, id: string): Dag => ({
	...before,
	commits: [
		...before.commits,
		{ id, message: `chore: ${id}`, files: { "README.md": id } },
	],
});

const tip = (d: Dag) => d.commits.at(-1)?.id ?? "";

const push = (before: string) => ({ name: "push", payload: { before } });

/**
 * Remote with `main` at the dag's HEAD and a release PR for a and b opened by
 * `pr`; `runs` are the head shas of successful runs, newest first.
 */
const setup = async (start: Dag = dag) => {
	const remote = memoryRemote();
	remote.branches.set("main", tip(start));
	const runs: string[] = [];
	const forge = fakeForge(runs, remote);
	const cli = async (args: string[], runDag: Dag, opts: RunOptions = {}) => {
		const gitWriter = fakeGitWriter(remote);

		return await runCli(args, {
			...memoryRepo(runDag, [remote.tags, gitWriter.tags]),
			forge,
			gitWriter,
			clock: () => new Date("2026-10-15T12:00:00Z"),
			...opts,
			env: { ...env, ...opts.env },
		});
	};

	await cli(["pr"], start);

	const merge = (before: Dag): Dag => {
		const merged = mergePr(before, remote, 1);
		remote.branches.set("main", tip(merged));

		return merged;
	};

	/** `run --out` at `runDag`: the result and the plan file. */
	const run = async (runDag: Dag, args: string[], opts: RunOptions = {}) => {
		const out = join(tmpDir("run"), "plan.json");
		const result = await cli(["run", "--out", out, ...args], runDag, opts);

		return {
			...result,
			plan:
				result.code === 0
					? planSchema.parse(JSON.parse(readFileSync(out, "utf8")))
					: undefined,
		};
	};

	/** Runs `run` twice; the second run writes nothing to the remote or forge. */
	const twice = async (runDag: Dag, args: string[], opts: RunOptions = {}) => {
		const first = await run(runDag, args, opts);
		const calls = remote.calls.length;
		const second = await run(runDag, args, opts);
		expect(remote.calls).toHaveLength(calls);

		return [first, second] as const;
	};

	return { remote, runs, cli, merge, run, twice };
};

describe("run", () => {
	it("lists the tags it reconciled in released and as base tags (E14, E23, E26)", async () => {
		const { remote, runs, merge, twice } = await setup();
		runs.push("c2");
		const merged = merge(dag);
		remote.calls.length = 0;

		const [first, second] = await twice(merged, [], { event: push("c2") });
		// Plan warnings repeated by the pr step print once.
		expect(first).toMatchObject({
			code: 0,
			stderr: 'warning[W_GROUP_EMPTY]: group "empty" selects no unit\n',
		});
		expect(first.stdout).toMatch(
			/^PR #1: tagged a-v1\.1\.0, b-v1\.1\.0 at merge-1\nPR #1: created releases a-v1\.1\.0, b-v1\.1\.0\nPR #1: labelled released\nno release PRs\n/u,
		);
		expect(remote.tags).toEqual(
			new Map([
				["a-v1.1.0", "merge-1"],
				["b-v1.1.0", "merge-1"],
			]),
		);
		const released = [
			{ id: "a", tag: "a-v1.1.0", releaseSha: "merge-1", catchUp: false },
			{ id: "b", tag: "b-v1.1.0", releaseSha: "merge-1", catchUp: false },
		].map((r) => ({ ...r, forge: { pr: { number: 1 } } }));
		expect(first.plan?.released).toMatchObject(released);
		expect(first.plan?.units.map((u) => [u.id, u.baseTag])).toEqual([
			["a", "a-v1.1.0"],
			["b", "b-v1.1.0"],
		]);

		// Re-run on the same sha: reconcile is a no-op, the PR comes from the forge.
		expect(second.stdout).toMatch(/^no merged release PRs\nno release PRs\n/u);
		expect(second.plan?.released).toMatchObject(released);
	});

	it("lists a release tagged by a later push run as a catch-up (E09)", async () => {
		const { runs, merge, twice } = await setup();
		runs.push("c2");
		const later = commit(merge(dag), "c4");

		const [first] = await twice(later, [], { event: push("merge-1") });
		expect(first.stdout).toContain(
			"PR #1: tagged a-v1.1.0, b-v1.1.0 at merge-1",
		);
		expect(first.plan?.released).toMatchObject([
			{
				tag: "a-v1.1.0",
				releaseSha: "merge-1",
				catchUp: true,
				forge: { pr: { number: 1 } },
			},
			{
				tag: "b-v1.1.0",
				releaseSha: "merge-1",
				catchUp: true,
				forge: { pr: { number: 1 } },
			},
		]);
	});

	it("emits a release again until a run succeeds (E16)", async () => {
		const { runs, merge, run } = await setup();
		runs.push("c2");
		const merged = merge(dag);
		await run(merged, [], { event: push("c2") });
		const later = commit(merged, "c4");

		// The run at merge-1 failed to publish: the last success is still c2.
		const failed = await run(later, [], { event: push("merge-1") });
		expect(failed.plan?.released).toMatchObject([
			{ tag: "a-v1.1.0", catchUp: true, forge: { pr: { number: 1 } } },
			{ tag: "b-v1.1.0", catchUp: true, forge: { pr: { number: 1 } } },
		]);

		runs.unshift("merge-1");
		const succeeded = await run(later, [], { event: push("merge-1") });
		expect(succeeded.plan?.released).toEqual([]);
	});

	it("fails on a forge error before any effect, else lists only this run's releases without a base (E34)", async () => {
		const { remote, cli, merge, twice } = await setup();
		const later = commit(merge(dag), "c4");
		const dispatch = { name: "workflow_dispatch", payload: {} };
		remote.calls.length = 0;

		const failing = {
			...fakeForge([], remote),
			lastSuccessfulPushRuns: async () =>
				await Promise.reject(new Error("forge down")),
		};
		for (let i = 0; i < 2; i++) {
			// eslint-disable-next-line no-await-in-loop -- runs in order
			const result = await cli(["run"], later, {
				event: dispatch,
				forge: failing,
			});
			expect(result).toMatchObject({
				code: 1,
				stdout: "",
				stderr: expect.stringContaining("error[E_BASE_REQUIRED]"),
			});
		}

		expect(remote.calls).toEqual([]);
		expect(remote.tags.size).toBe(0);
		expect(remote.prs[0]?.labels).toEqual(["tallyrelease: pending"]);

		const [first, second] = await twice(later, [], { event: dispatch });
		expect(first.stderr).toContain("warning[W_NO_LAST_SUCCESS]");
		expect(first.plan?.released).toMatchObject([
			{ tag: "a-v1.1.0", catchUp: true, forge: { pr: { number: 1 } } },
			{ tag: "b-v1.1.0", catchUp: true, forge: { pr: { number: 1 } } },
		]);
		expect(first.plan?.warnings.map((w) => w.code)).toContain(
			"W_RELEASED_NO_BASE",
		);
		expect(second.plan?.released).toEqual([]);
	});

	it("prints the actions without effects with --dry-run (E27)", async () => {
		const { remote, runs, merge, twice } = await setup();
		runs.push("c2");
		const merged = merge(dag);
		remote.calls.length = 0;

		const [first, second] = await twice(merged, ["--dry-run"], {
			event: push("c2"),
		});
		expect(first.stdout).toMatch(
			/^PR #1: would tag a-v1\.1\.0, b-v1\.1\.0 at merge-1\nPR #1: would create releases a-v1\.1\.0, b-v1\.1\.0\nPR #1: would label released\nno release PRs\n/u,
		);
		expect(first.plan?.released).toMatchObject([
			{ tag: "a-v1.1.0", forge: { pr: { number: 1 }, release: null } },
			{ tag: "b-v1.1.0", forge: { pr: { number: 1 }, release: null } },
		]);
		expect(second).toEqual(first);
		expect(remote.calls).toEqual([]);
		expect(remote.tags.size).toBe(0);
	});

	it("tags merges in HEAD but leaves release PRs alone on an old run (E33)", async () => {
		const { remote, runs, merge, twice } = await setup();
		runs.push("c2");
		const merged = merge(dag);
		// A later merged release PR and a newer line tip than this run's HEAD.
		remote.prs.push(
			...remote.prs.map((p) => ({
				...p,
				number: 2,
				mergedAt: "2026-10-16T00:00:00Z",
				mergeCommitSha: "newer",
			})),
		);
		remote.branches.set("main", "newer");
		remote.calls.length = 0;

		const [first] = await twice(merged, [], { event: push("c2") });
		expect(first).toMatchObject({
			code: 0,
			stderr: expect.stringContaining("warning[W_PR_HEAD_BEHIND]"),
		});
		expect(first.stdout).toContain(
			"PR #1: labelled released\nPR #2: merge newer is not in HEAD; left pending\n",
		);
		expect(remote.prs.map((p) => p.labels)).toEqual([
			["tallyrelease: released"],
			["tallyrelease: pending"],
		]);
	});

	it("does nothing on pull request events and without a line rule", async () => {
		const { remote, cli } = await setup();
		remote.calls.length = 0;

		expect(
			await cli(["run"], dag, { event: { name: "pull_request", payload: {} } }),
		).toEqual({
			code: 0,
			stdout: "",
			stderr:
				"warning[W_EFFECT_SKIPPED]: run does nothing on pull_request events\n",
		});
		expect((await cli(["run", "--branch", "feature"], dag)).stderr).toBe(
			'warning[W_EFFECT_SKIPPED]: run does nothing on branch "feature" without a line rule\n',
		);
		expect(remote.calls).toEqual([]);
	});
});

describe("run --github-output", () => {
	/** The `releases` output of `run` at `runDag`. */
	const releasesOf = async (
		harness: Awaited<ReturnType<typeof setup>>,
		runDag: Dag,
		before: string,
		opts: RunOptions = {},
	) => {
		const dir = tmpDir("gh-output");
		const githubOutput = join(dir, "output");
		writeFileSync(githubOutput, "");
		const result = await harness.cli(
			["run", "--github-output", "--out", join(dir, "plan.json")],
			runDag,
			{
				event: push(before),
				...opts,
				env: { ...opts.env, GITHUB_OUTPUT: githubOutput },
			},
		);
		expect(result.code).toBe(0);
		const lines = readFileSync(githubOutput, "utf8").split("\n");
		const line = lines.find((l) => l.startsWith("releases="));

		return {
			stderr: result.stderr,
			plan: lines.find((l) => l.startsWith("plan=")),
			releases: z
				.array(releaseEntrySchema)
				.parse(JSON.parse(line?.slice("releases=".length) ?? "null")),
		};
	};

	it("lists releases then prereleases, with catch-up and sha (E08, E13)", async () => {
		const harness = await setup();
		harness.runs.push("c2");
		const merged = harness.merge(dag);
		const later = commit(
			{
				...merged,
				commits: [
					...merged.commits.map((c, i) =>
						i === 0
							? {
									...c,
									files: {
										...c.files,
										"tallyrelease.yaml": config.replace(
											"line: default }",
											"line: default, channel: beta }",
										),
									},
								}
							: c,
					),
					{
						id: "c5",
						message: "feat(a): more a",
						files: { "packages/a/y.ts": "1" },
					},
				],
			},
			"c6",
		);

		const { plan, releases } = await releasesOf(harness, later, "merge-1");
		expect(plan).toMatch(/^plan=.*plan\.json$/u);
		expect(releases).toMatchObject([
			{
				id: "a",
				kind: "release",
				tag: "a-v1.1.0",
				channel: null,
				releaseSha: "merge-1",
				catchUp: true,
				forge: {
					pr: { number: 1, url: "pull/1" },
					release: { url: "release/a-v1.1.0" },
				},
				line: "default",
			},
			{
				id: "b",
				kind: "release",
				tag: "b-v1.1.0",
				catchUp: true,
				line: "default",
			},
			{
				id: "a",
				kind: "prerelease",
				tag: null,
				catchUp: false,
				line: "default",
			},
		]);
		expect(releases[2]?.releaseSha).toBe(tip(later));
		// The released commits, then the change pending since a-v1.1.0.
		expect(
			releases.map((r) => r.changes.map((c) => [c.sha, c.subject])),
		).toEqual([[["c1", "add a"]], [["c2", "add b"]], [["c5", "more a"]]]);
	});

	it("emits every release again until a run succeeds (E24, E25)", async () => {
		const harness = await setup();
		harness.runs.push("c2");
		const merged = harness.merge(dag);
		await releasesOf(harness, merged, "c2");
		const later = commit(merged, "c4");

		const again = await releasesOf(harness, later, "merge-1");
		expect(again.releases.map((r) => [r.tag, r.catchUp])).toEqual([
			["a-v1.1.0", true],
			["b-v1.1.0", true],
		]);
		// Looked up on the forge: the PR of merge-1 and the release created earlier.
		expect(again.releases[0]?.forge).toEqual({
			pr: { number: 1, url: "pull/1" },
			release: { url: "release/a-v1.1.0" },
		});
		// Not reconciled in this run: planned at the parent of merge-1.
		expect(
			again.releases.map((r) => r.changes.map((c) => [c.sha, c.subject])),
		).toEqual([[["c1", "add a"]], [["c2", "add b"]]]);
	});

	it("builds a tag-only unit released at HEAD despite an ignored changelog (E37)", async () => {
		const start: Dag = {
			commits: [
				{
					id: "c0",
					files: {
						"tallyrelease.yaml": `${config}ignore: ["**/*.md"]\nunits:\n  infra/tf: { id: tf }\n`,
						"package.json": json({ workspaces: ["packages/*"] }),
						"packages/a/package.json": json({ name: "@s/a", version: "1.0.0" }),
						"infra/tf/main.tf": "0",
					},
				},
				{
					id: "c1",
					message: "feat(a): add a",
					files: { "packages/a/x.ts": "1" },
				},
				{
					id: "c2",
					message: "fix(tf): fix tf",
					files: { "infra/tf/main.tf": "1" },
				},
			],
			tags: [
				{ name: "a-v1.0.0", commit: "c0" },
				{ name: "tf-v1.0.0", commit: "c0" },
			],
		};
		const harness = await setup(start);
		harness.runs.push("c2");
		const merged = harness.merge(start);

		const { plan, releases } = await releasesOf(harness, merged, "c2");
		expect(releases.find((r) => r.id === "tf")).toMatchObject({
			kind: "release",
			tag: "tf-v1.0.1",
			catchUp: false,
		});
		const built = planSchema
			.parse(
				JSON.parse(readFileSync(plan?.slice("plan=".length) ?? "", "utf8")),
			)
			.units.filter((u) => u.affected !== null)
			.map((u) => u.id);
		for (const r of releases.filter((e) => !e.catchUp)) {
			expect(built).toContain(r.id);
		}
	});

	describe("build numbers", () => {
		/** `dag` with branch `rules` and unit overlays; main gets a channel. */
		const withConfig = (units: string[], rules: string[] = []): Dag => {
			const yaml = [
				config
					.replace("line: default }", "line: default, channel: beta }")
					.replace("branches:\n", ["branches:", ...rules, ""].join("\n")),
				"units:",
				...units,
				"",
			].join("\n");

			return {
				...dag,
				commits: dag.commits.map((c, i) =>
					i === 0
						? { ...c, files: { ...c.files, "tallyrelease.yaml": yaml } }
						: c,
				),
			};
		};

		const start = withConfig([
			"  packages/a: { buildNumber: { offset: 100 } }",
		]);
		/** A clone of `runDag` with the remote's tags that reports being shallow. */
		const shallow = (
			harness: Awaited<ReturnType<typeof setup>>,
			runDag: Dag,
		) => ({
			...memoryRepo(runDag, [harness.remote.tags]).git,
			isShallow: () => true,
		});

		it("lists build numbers", async () => {
			const harness = await setup(start);
			harness.runs.push("c2");
			const merged = harness.merge(start);
			const later: Dag = {
				...merged,
				commits: [
					...merged.commits,
					{
						id: "c5",
						message: "feat(a): more a",
						files: { "packages/a/y.ts": "1" },
					},
				],
			};
			const count = (sha: string) =>
				memoryGit(later).countFirstParent(null, sha) as number;

			const { releases, stderr } = await releasesOf(harness, later, "merge-1");
			expect(releases.map((r) => [r.id, r.kind, r.buildNumber])).toEqual([
				["a", "release", count("merge-1") + 100],
				["b", "release", null],
				["a", "prerelease", count("c5") + 100],
			]);
			expect(stderr).not.toContain("W_BUILD_NUMBER_MAINTENANCE");
		});

		it("fails in a shallow clone before any effect", async () => {
			const harness = await setup(start);
			harness.runs.push("c2");
			const merged = harness.merge(start);
			harness.remote.calls.length = 0;
			const dir = tmpDir("gh-output");
			const githubOutput = join(dir, "output");
			writeFileSync(githubOutput, "");

			const result = await harness.cli(
				["run", "--github-output", "--out", join(dir, "plan.json")],
				merged,
				{
					event: push("c2"),
					env: { GITHUB_OUTPUT: githubOutput },
					git: shallow(harness, merged),
				},
			);
			expect(result).toMatchObject({
				code: 1,
				stderr: expect.stringContaining("error[E_BUILD_NUMBER_SHALLOW]"),
			});
			expect(harness.remote.calls).toEqual([]);
			expect(harness.remote.tags.size).toBe(0);
			expect(harness.remote.prs).toHaveLength(1);
			expect(harness.remote.prs[0]?.labels).toEqual(["tallyrelease: pending"]);
		});

		it("does not check shallow without --github-output", async () => {
			const harness = await setup(start);
			harness.runs.push("c2");
			const merged = harness.merge(start);

			const result = await harness.run(merged, [], {
				event: push("c2"),
				git: shallow(harness, merged),
			});
			expect(result.code).toBe(0);
			expect(harness.remote.tags.has("a-v1.1.0")).toBe(true);
		});

		it("does not check shallow without a unit with buildNumber", async () => {
			const harness = await setup();
			harness.runs.push("c2");
			const merged = harness.merge(dag);

			const { releases } = await releasesOf(harness, merged, "c2", {
				git: shallow(harness, merged),
			});
			expect(releases.map((r) => r.buildNumber)).toEqual([null, null]);
		});

		it("warns on a maintenance line", async () => {
			const maintenance = withConfig(
				[
					"  packages/a: { buildNumber: {} }",
					"  packages/b: { buildNumber: {} }",
				],
				[
					'  - { name: "release/{major}.x", line: maintenance, channel: "rc-{major}" }',
				],
			);
			const harness = await setup(maintenance);

			const { releases, stderr } = await releasesOf(
				harness,
				maintenance,
				"c0",
				{
					env: { GITHUB_REF_NAME: "release/1.x" },
				},
			);
			const head = memoryGit(maintenance).countFirstParent(null, "c2");
			expect(
				releases.map((r) => [r.id, r.kind, r.line, r.buildNumber]),
			).toEqual([
				["a", "prerelease", "maintenance", head],
				["b", "prerelease", "maintenance", head],
			]);
			expect(
				stderr.match(/warning\[W_BUILD_NUMBER_MAINTENANCE\]/g),
			).toHaveLength(2);
		});
	});
});

describe("run --github-output with several releases of a unit", () => {
	it("lists them oldest first without a warning (E35)", async () => {
		// A failed window: b-v1.0.5 at c1 was tagged but never published.
		const start: Dag = {
			...dag,
			tags: [...(dag.tags ?? []), { name: "b-v1.0.5", commit: "c1" }],
		};
		const harness = await setup(start);
		harness.runs.push("c0");
		const merged = harness.merge(start);
		const dir = tmpDir("gh-output");
		const githubOutput = join(dir, "output");
		writeFileSync(githubOutput, "");

		const result = await harness.cli(
			["run", "--github-output", "--out", join(dir, "plan.json")],
			merged,
			{ event: push("c2"), env: { GITHUB_OUTPUT: githubOutput } },
		);
		expect(result).toMatchObject({ code: 0 });
		expect(result.stderr).not.toContain("SUPERSEDED");
		const line = readFileSync(githubOutput, "utf8")
			.split("\n")
			.find((l) => l.startsWith("releases="));
		const releases = z
			.array(releaseEntrySchema)
			.parse(JSON.parse(line?.slice("releases=".length) ?? "null"));
		expect(releases.map((r) => [r.tag, r.releaseSha, r.latest])).toEqual([
			["b-v1.0.5", "c1", false],
			["a-v1.1.0", "merge-1", true],
			["b-v1.1.0", "merge-1", true],
		]);
	});
});

describe("plan", () => {
	it("fills released with the PR and release of the tag, forge null without a token (E26)", async () => {
		const { runs, merge, run, cli } = await setup();
		runs.push("c2");
		const merged = merge(dag);
		await run(merged, [], { event: push("c2") });

		const plan = async (opts: RunOptions) => {
			const result = await cli(["plan", "--json"], merged, {
				event: push("c2"),
				...opts,
			});

			return planSchema.parse(JSON.parse(result.stdout)).released;
		};

		expect(await plan({})).toMatchObject([
			{
				tag: "a-v1.1.0",
				forge: {
					pr: { number: 1, url: "pull/1" },
					release: { url: "release/a-v1.1.0" },
				},
			},
			{ tag: "b-v1.1.0", forge: { pr: { number: 1 } } },
		]);
		expect(await plan({ env: { GITHUB_TOKEN: undefined } })).toMatchObject([
			{ tag: "a-v1.1.0", forge: null },
			{ tag: "b-v1.1.0", forge: null },
		]);
	});
});
