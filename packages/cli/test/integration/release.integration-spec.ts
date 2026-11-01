import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
	fakeForge,
	fakeGitWriter,
	memoryRemote,
	mergePr,
} from "./harness/fake-forge.js";
import { createRepo, git, removeTmpDirs, tmpDir } from "./harness/git-repo.js";
import { memoryRepo } from "./harness/memory-repo.js";
import { runCli } from "./harness/run-cli.js";
import { planSchema } from "../../src/plan-schema.js";

import type { RunOptions } from "./harness/run-cli.js";
import type { Dag } from "@tallyrelease/core/testing";

afterAll(removeTmpDirs);

const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

const env = {
	GITHUB_TOKEN: "t",
	GITHUB_SERVER_URL: "https://github.com",
	GITHUB_REPOSITORY: "acme/repo",
};

const config = (extra = "", defaults = "release: true") => `
plugins: { node: {} }
defaults: { ${defaults} }
branches:
  - { name: main, line: default }
  - { name: "release/{major}.x", line: maintenance }
${extra}`;

/** Units `ids` at `version`, tagged unless `0.0.0`, then one feat on each of `feats`. */
const repo = (
	yaml: string,
	{
		ids = ["a", "b", "c"],
		feats = ["a", "b"],
		version = "1.0.0",
	}: { ids?: string[]; feats?: string[]; version?: string } = {},
): Dag => ({
	commits: [
		{
			id: "c0",
			files: {
				"tallyrelease.yaml": yaml,
				"package.json": json({ workspaces: ["packages/*"] }),
				...Object.fromEntries(
					ids.map((id) => [
						`packages/${id}/package.json`,
						json({ name: `@s/${id}`, version }),
					]),
				),
			},
		},
		...feats.map((id, i) => ({
			id: `c${String(i + 1)}`,
			message: `feat(${id}): add ${id}`,
			files: { [`packages/${id}/x.ts`]: "1" },
		})),
	],
	tags:
		version === "0.0.0"
			? []
			: ids.map((id) => ({ name: `${id}-v${version}`, commit: "c0" })),
});

const commit = (dag: Dag, id: string, message: string, path: string): Dag => ({
	...dag,
	commits: [...dag.commits, { id, message, files: { [path]: id } }],
});

/**
 * Remote with the line branch at HEAD; every run gets a fresh writer, so
 * only pushed tags outlive it.
 */
const setup = (dag: Dag, branch = "main") => {
	const remote = memoryRemote();
	remote.branches.set(branch, dag.commits.at(-1)?.id ?? "");
	const forge = fakeForge([], remote);
	const run = async (
		command: string,
		runDag: Dag,
		args: string[] = [],
		opts: RunOptions = {},
	) => {
		const gitWriter = fakeGitWriter(remote);

		return await runCli([command, ...args], {
			...memoryRepo(runDag, [remote.tags, gitWriter.tags]),
			forge,
			gitWriter,
			clock: () => new Date("2026-10-15T12:00:00Z"),
			...opts,
			env: { ...env, ...opts.env },
		});
	};

	const merge = (
		before: Dag,
		number: number,
		opts?: { mergeCommit?: boolean },
	) => {
		const merged = mergePr(before, remote, number, opts);
		remote.branches.set(branch, merged.commits.at(-1)?.id ?? "");

		return merged;
	};

	/** Runs `release` twice; the second run must change nothing. */
	const release = async (runDag: Dag, args: string[] = []) => {
		const first = await run("release", runDag, args);
		const calls = remote.calls.length;
		const second = await run("release", runDag, args);
		expect(second).toEqual({
			code: 0,
			stdout: first.stdout.includes("left pending")
				? expect.any(String)
				: "no merged release PRs\n",
			stderr: "",
		});
		expect(remote.calls).toHaveLength(calls);

		return first;
	};

	const methods = () => remote.calls.map(([method]) => method);

	return { remote, forge, run, merge, release, methods };
};

describe("release", () => {
	for (const mergeCommit of [false, true]) {
		it(`tags a ${mergeCommit ? "merge-commit" : "squash"} merge at the merge sha (E04, E36)`, async () => {
			const dag = repo(config());
			const { remote, run, merge, release, methods } = setup(dag);
			await run("pr", dag);
			const merged = merge(dag, 1, { mergeCommit });
			remote.calls.length = 0;

			expect(await release(merged)).toEqual({
				code: 0,
				stdout: [
					"PR #1: tagged a-v1.1.0, b-v1.1.0 at merge-1",
					"PR #1: created releases a-v1.1.0, b-v1.1.0",
					"PR #1: labelled released",
					"",
				].join("\n"),
				stderr: "",
			});
			expect(remote.tags).toEqual(
				new Map([
					["a-v1.1.0", "merge-1"],
					["b-v1.1.0", "merge-1"],
				]),
			);
			expect(remote.calls[0]).toEqual([
				"push",
				["refs/tags/a-v1.1.0", "refs/tags/b-v1.1.0"],
				{ atomic: true, token: "t" },
			]);
			expect(methods()).toEqual([
				"push",
				"createRelease",
				"createRelease",
				"setLabel",
			]);
			expect(remote.releases[0]).toMatchObject({
				tag: "a-v1.1.0",
				name: "a: v1.1.0",
				makeLatest: true,
			});
			expect(remote.releases[0]?.body).toMatch(
				/^## \[1\.1\.0\]\(https:\/\/github\.com\/acme\/repo\/compare\/a-v1\.0\.0\.\.\.a-v1\.1\.0\) \(2026-10-15\)\n\n\n### Features\n\n\* \*\*a:\*\* add a \(\[c1\]\(.*\)\)$/u,
			);
			expect(remote.prs[0]?.labels).toEqual(["tallyrelease: released"]);

			// The next release PR run sees nothing pending and nothing to reconcile.
			expect((await run("pr", merged)).stdout).toBe("no release PRs\n");
		});
	}

	it("finishes a partially failed run without a new push or plan check", async () => {
		const dag = repo(config());
		const { remote, forge, run, merge, release, methods } = setup(dag);
		await run("pr", dag);
		const merged = merge(dag, 1);
		const failing = {
			...forge,
			createRelease: async () =>
				await Promise.reject(Object.assign(new Error("boom"), { status: 500 })),
		};
		expect(await run("release", merged, [], { forge: failing })).toMatchObject({
			code: 1,
			stderr: expect.stringContaining("boom"),
		});
		expect(remote.tags.get("a-v1.1.0")).toBe("merge-1");
		expect(remote.prs[0]?.labels).toEqual(["tallyrelease: pending"]);
		// A newer release of `a` exists by now; the plan at the merge would differ.
		remote.tags.set("a-v2.0.0", "c0");
		remote.calls.length = 0;

		expect((await release(merged)).stdout).toBe(
			[
				"PR #1: created releases a-v1.1.0, b-v1.1.0",
				"PR #1: labelled released",
				"",
			].join("\n"),
		);
		expect(methods()).toEqual(["createRelease", "createRelease", "setLabel"]);
		expect(remote.releases).toMatchObject([
			{ tag: "a-v1.1.0", makeLatest: false },
			{ tag: "b-v1.1.0", makeLatest: true },
		]);
	});

	it("takes the release another run created between lookup and create", async () => {
		const dag = repo(config(), { feats: ["a"] });
		const { remote, forge, run, merge } = setup(dag);
		await run("pr", dag);
		const merged = merge(dag, 1);
		const lookups: string[] = [];
		const racing: typeof forge = {
			...forge,
			releaseByTag: async (repoRef, tag) => {
				lookups.push(tag);
				if (lookups.length === 1) {
					remote.releases.push({
						tag,
						name: tag,
						body: "",
						makeLatest: true,
						id: 9,
					});

					return undefined;
				}

				return await forge.releaseByTag(repoRef, tag);
			},
		};
		const out = join(tmpDir("release"), "plan.json");

		const result = await run("run", merged, ["--out", out], { forge: racing });
		expect(result.code).toBe(0);
		expect(lookups).toEqual(["a-v1.1.0", "a-v1.1.0"]);
		expect(remote.releases.map((r) => r.id)).toEqual([9]);
		expect(
			planSchema.parse(JSON.parse(readFileSync(out, "utf8"))).released,
		).toMatchObject([
			{ tag: "a-v1.1.0", forge: { release: { url: "release/a-v1.1.0" } } },
		]);
	});

	it("ignores a direct-push release commit without a PR (E36)", async () => {
		const dag = commit(
			repo(config()),
			"c3",
			"chore(release): a@1.1.0",
			"packages/a/CHANGELOG.md",
		);
		const { remote, release } = setup(dag);

		expect((await release(dag)).stdout).toBe("no merged release PRs\n");
		expect(remote.tags.size).toBe(0);
	});

	it("labels a merge whose plan changed stale, then proposes it again (E05)", async () => {
		const dag = repo(config());
		const { remote, run, merge, release } = setup(dag);
		await run("pr", dag);
		const moved = commit(dag, "c3", "feat(a)!: break", "packages/a/y.ts");
		const merged = merge(moved, 1);
		remote.calls.length = 0;

		expect(await release(merged)).toEqual({
			code: 0,
			stdout:
				"PR #1: labelled stale: its releases differ from the plan at c3, the commit it was merged onto\n",
			stderr: "",
		});
		expect(remote.tags.size).toBe(0);
		expect(remote.prs[0]).toMatchObject({
			labels: ["tallyrelease: stale"],
			comments: [expect.stringContaining("did not tag this release PR")],
		});

		expect((await run("pr", merged)).stdout).toBe(
			"created PR #2 tallyrelease/release/main/shared: chore(release): main\n",
		);
		const files = remote.commits.get(remote.prs[1]?.headSha ?? "")?.files ?? {};
		const changelog = files["packages/a/CHANGELOG.md"] ?? "";
		expect(changelog.match(/^## /gmu)).toHaveLength(1);
		expect(changelog).toContain("## [2.0.0]");
		expect(files["packages/a/package.json"]).toContain('"version": "2.0.0"');
	});

	it("labels a PR whose head is not the release commit stale (E10)", async () => {
		const dag = repo(config());
		const { remote, run, merge, release } = setup(dag);
		await run("pr", dag);
		const merged = merge(dag, 1);
		const releaseCommit = remote.prs[0]?.headSha ?? "";
		Object.assign(remote.prs[0] ?? {}, { headSha: "racing" });

		expect((await release(merged)).stdout).toBe(
			`PR #1: labelled stale: its head racing is not the release commit ${releaseCommit.slice(0, 7)}\n`,
		);
		expect(remote.tags.size).toBe(0);
	});

	it("tags a merge queued behind an unrelated commit (E15)", async () => {
		const dag = repo(config());
		const { remote, run, merge, release } = setup(dag);
		await run("pr", dag);
		const moved = commit(dag, "c3", "chore(c): tidy", "packages/c/y.ts");

		expect((await release(merge(moved, 1))).stdout).toContain(
			"PR #1: tagged a-v1.1.0, b-v1.1.0 at merge-1",
		);
		expect(remote.tags.get("a-v1.1.0")).toBe("merge-1");
	});

	/** Calver units planned in December 2024; `mergePr` dates merges in January 2025. */
	const december = (): Dag => {
		const dag = repo(config(`units: { "packages/*": { scheme: calver } }`), {
			version: "2024.12.0",
		});

		return {
			...dag,
			commits: dag.commits.map((c) => ({ ...c, date: "2024-12-31T12:00:00Z" })),
		};
	};

	it("tags a calver release merged in the next month at its planned version", async () => {
		const dag = december();
		const { remote, run, merge, release } = setup(dag);
		await run("pr", dag);
		const merged = merge(dag, 1);
		expect(merged.commits.at(-1)?.date).toMatch(/^2025-01-/u);

		expect((await release(merged)).stdout).toContain(
			"PR #1: tagged a-v2024.12.1, b-v2024.12.1 at merge-1",
		);
		expect(remote.tags.get("a-v2024.12.1")).toBe("merge-1");
	});

	it("labels a calver release PR stale when main moves to the next month first", async () => {
		const dag = december();
		const { remote, run, merge, release } = setup(dag);
		await run("pr", dag);
		const moved: Dag = {
			...dag,
			commits: [
				...dag.commits,
				{
					id: "c3",
					message: "chore(c): tidy",
					date: "2025-01-01T00:00:00Z",
					files: { "packages/c/y.ts": "c3" },
				},
			],
		};

		expect((await release(merge(moved, 1))).stdout).toBe(
			"PR #1: labelled stale: its releases differ from the plan at c3, the commit it was merged onto\n",
		);
		expect(remote.tags.size).toBe(0);
	});

	it("moves only the highest floating tags and keeps maintenance releases off latest (E07, E11)", async () => {
		const yaml = config(`tags:
  floating: ["{id}-v{major}", "{id}-latest"]`);
		const dag: Dag = {
			commits: [
				{
					id: "c0",
					files: {
						"tallyrelease.yaml": yaml,
						"package.json": json({ workspaces: ["packages/*"] }),
						"packages/a/package.json": json({ name: "@s/a", version: "1.0.0" }),
					},
				},
				{ id: "x", message: "feat(a)!: v2", files: { "packages/a/x.ts": "2" } },
				{
					id: "c1",
					parents: ["c0"],
					message: "fix(a): hotfix",
					files: { "packages/a/y.ts": "1" },
				},
			],
			tags: [
				{ name: "a-v1.0.0", commit: "c0" },
				{ name: "a-v2.0.0", commit: "x" },
			],
		};
		const branch = ["--branch", "release/1.x"];
		const { remote, run, merge, release } = setup(dag, "release/1.x");
		expect((await run("pr", dag, branch)).stdout).toBe(
			"created PR #1 tallyrelease/release/release/1.x/shared: chore(release): release/1.x\n",
		);
		const merged = merge(dag, 1);
		remote.calls.length = 0;

		expect((await release(merged, branch)).stdout).toBe(
			[
				"PR #1: tagged a-v1.0.1 at merge-1",
				"PR #1: moved a-v1",
				"PR #1: created releases a-v1.0.1",
				"PR #1: labelled released",
				"",
			].join("\n"),
		);
		expect(remote.calls[0]).toEqual([
			"push",
			["refs/tags/a-v1.0.1", "+refs/tags/a-v1"],
			{ atomic: true, token: "t" },
		]);
		expect(remote.tags.get("a-v1")).toBe("merge-1");
		expect(remote.tags.has("a-latest")).toBe(false);
		expect(remote.releases).toMatchObject([
			{ tag: "a-v1.0.1", makeLatest: false },
		]);
	});

	it("fails with E_TAG_EXISTS and pushes nothing (E12)", async () => {
		const dag = repo(config());
		const { remote, run, merge } = setup(dag);
		await run("pr", dag);
		const merged = merge(dag, 1);
		remote.tags.set("b-v1.1.0", "elsewhere");
		remote.calls.length = 0;

		for (let i = 0; i < 2; i++) {
			// eslint-disable-next-line no-await-in-loop -- runs in order
			expect(await run("release", merged)).toMatchObject({
				code: 1,
				stderr: expect.stringContaining("error[E_TAG_EXISTS]"),
			});
		}

		expect(remote.calls).toEqual([]);
		expect(remote.tags.has("a-v1.1.0")).toBe(false);
		expect(remote.prs[0]?.labels).toEqual(["tallyrelease: pending"]);
	});

	it("tags a group's first release per member (E21)", async () => {
		const yaml = `
plugins: { node: {} }
defaults: { release: true, initialVersion: 1.0.0, tagFormat: "app-{id}-v{version}" }
groups:
  groundwork: { units: [api-server, groundwork] }
branches:
  - { name: main, line: default }
`;
		const dag = repo(yaml, {
			ids: ["api-server", "groundwork"],
			feats: ["api-server", "groundwork"],
			version: "0.0.0",
		});
		const { remote, run, merge, release } = setup(dag);
		expect((await run("pr", dag)).stdout).toBe(
			"created PR #1 tallyrelease/release/main/shared: chore(release): main\n",
		);
		const files = remote.commits.get(remote.prs[0]?.headSha ?? "")?.files;
		for (const id of ["api-server", "groundwork"]) {
			expect(files?.[`packages/${id}/CHANGELOG.md`]).toContain(
				`## 1.0.0 (2026-10-15)\n\n\n### Features\n\n* **${id}:** add ${id}`,
			);
		}

		const merged = merge(dag, 1);
		expect((await release(merged)).stdout).toContain(
			"PR #1: tagged app-api-server-v1.0.0, app-groundwork-v1.0.0 at merge-1",
		);
		expect([...remote.tags]).toEqual([
			["app-api-server-v1.0.0", "merge-1"],
			["app-groundwork-v1.0.0", "merge-1"],
		]);
		expect(remote.releases.map((r) => r.name)).toEqual([
			"app-api-server: v1.0.0",
			"app-groundwork: v1.0.0",
		]);
	});

	it("reconciles two merged PRs oldest first (E29)", async () => {
		const dag = repo(config("", "release: true, releasePr: separate"));
		const { remote, run, merge, release } = setup(dag);
		await run("pr", dag);
		const merged = merge(merge(dag, 1), 2);

		expect((await release(merged)).stdout).toBe(
			[
				"PR #1: tagged a-v1.1.0 at merge-1",
				"PR #1: created releases a-v1.1.0",
				"PR #1: labelled released",
				"PR #2: tagged b-v1.1.0 at merge-2",
				"PR #2: created releases b-v1.1.0",
				"PR #2: labelled released",
				"",
			].join("\n"),
		);
		expect([...remote.tags]).toEqual([
			["a-v1.1.0", "merge-1"],
			["b-v1.1.0", "merge-2"],
		]);
	});

	it("leaves merges after HEAD pending on an old run (E33)", async () => {
		const dag = repo(config("", "release: true, releasePr: separate"));
		const { remote, run, merge, release } = setup(dag);
		await run("pr", dag);
		const first = merge(dag, 1);
		const second = merge(first, 2);

		expect((await release(first)).stdout).toBe(
			[
				"PR #1: tagged a-v1.1.0 at merge-1",
				"PR #1: created releases a-v1.1.0",
				"PR #1: labelled released",
				"PR #2: merge merge-2 is not in HEAD; left pending",
				"",
			].join("\n"),
		);
		expect(remote.prs.map((p) => p.labels)).toEqual([
			["tallyrelease: released"],
			["tallyrelease: pending"],
		]);

		expect((await release(second)).stdout).toContain(
			"PR #2: tagged b-v1.1.0 at merge-2",
		);
	});

	it("prints the actions without effects with --dry-run (E27)", async () => {
		const dag = repo(config());
		const { remote, run, merge } = setup(dag);
		await run("pr", dag);
		const merged = merge(dag, 1);
		remote.calls.length = 0;

		expect(await run("release", merged, ["--dry-run"])).toEqual({
			code: 0,
			stdout: [
				"PR #1: would tag a-v1.1.0, b-v1.1.0 at merge-1",
				"PR #1: would create releases a-v1.1.0, b-v1.1.0",
				"PR #1: would label released",
				"",
			].join("\n"),
			stderr: "",
		});
		expect(remote.calls).toEqual([]);
		expect(remote.tags.size).toBe(0);
	});

	it("fails when the forge cannot list release PRs", async () => {
		const dag = repo(config());
		const { forge, run } = setup(dag);
		const failing = {
			...forge,
			releasePrs: async () => await Promise.reject(new Error("forge down")),
		};

		expect(await run("release", dag, [], { forge: failing })).toMatchObject({
			code: 1,
			stderr: expect.stringContaining("forge down"),
		});
	});

	it("does nothing on pull request events, without a line rule or without a token", async () => {
		const dag = repo(config());
		const { remote, run } = setup(dag);

		expect(
			await run("release", dag, [], {
				event: { name: "pull_request", payload: {} },
			}),
		).toEqual({
			code: 0,
			stdout: "",
			stderr:
				"warning[W_EFFECT_SKIPPED]: release does nothing on pull_request events\n",
		});
		expect((await run("release", dag, ["--branch", "feature"])).stderr).toBe(
			'warning[W_EFFECT_SKIPPED]: release does nothing on branch "feature" without a line rule\n',
		);
		expect(remote.calls).toEqual([]);
		expect(
			await run("release", dag, [], { env: { GITHUB_TOKEN: undefined } }),
		).toMatchObject({
			code: 1,
			stderr: expect.stringContaining("error[E_NO_FORGE]"),
		});
	});

	it("opens, merges and tags with real git (E31)", async () => {
		const { dir, sha } = createRepo(repo(config()));
		const origin = tmpDir("origin.git");
		git(origin, "init", "--quiet", "--bare");
		git(dir, "remote", "add", "origin", origin);
		git(dir, "push", "--quiet", "origin", "main");
		const remote = memoryRemote();
		remote.branches.set("main", sha("c2"));
		const forge = fakeForge([], remote);
		const cli = async (args: string[]) =>
			await runCli(args, {
				cwd: dir,
				forge,
				clock: () => new Date("2026-10-15T12:00:00Z"),
				env,
			});

		expect((await cli(["pr"])).stdout).toBe(
			"created PR #1 tallyrelease/release/main/shared: chore(release): main\n",
		);
		const head = git(origin, "rev-parse", "tallyrelease/release/main/shared");
		git(
			dir,
			"-c",
			"user.name=T",
			"-c",
			"user.email=t@example.com",
			"cherry-pick",
			head,
		);
		git(dir, "push", "--quiet", "origin", "main");
		const mergeSha = git(dir, "rev-parse", "HEAD");
		Object.assign(remote.prs[0] ?? {}, {
			headSha: head,
			state: "closed",
			mergedAt: "2026-10-15T13:00:00Z",
			mergeCommitSha: mergeSha,
		});
		remote.branches.set("main", mergeSha);

		expect(await cli(["release"])).toEqual({
			code: 0,
			stdout: [
				`PR #1: tagged a-v1.1.0, b-v1.1.0 at ${mergeSha.slice(0, 7)}`,
				"PR #1: created releases a-v1.1.0, b-v1.1.0",
				"PR #1: labelled released",
				"",
			].join("\n"),
			stderr: "",
		});
		expect(git(origin, "rev-parse", "a-v1.1.0^{commit}")).toBe(mergeSha);
		expect(remote.releases[1]?.body).toContain("### Features");
		expect((await cli(["release"])).stdout).toBe("no merged release PRs\n");
		expect((await cli(["pr"])).stdout).toBe("no release PRs\n");
	});
});
