import { decodeMarker, encodeMarker } from "@tallyrelease/core";
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

import type { MemoryRemote } from "./harness/fake-forge.js";
import type { RunOptions } from "./harness/run-cli.js";
import type { Dag } from "@tallyrelease/core/testing";

afterAll(removeTmpDirs);

const SHARED = "tallyrelease/release/main/shared";
const CUT = "tallyrelease/prerelease/main/shared";

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
  - { name: main, line: default, channels: { build: alpha, cut: beta } }
`;

/** Units a and b at 1.0.0 (tagged at c0), one feat on a. */
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
	],
	tags: [
		{ name: "a-v1.0.0", commit: "c0" },
		{ name: "b-v1.0.0", commit: "c0" },
	],
};

const commit = (before: Dag, id: string, message = `chore: ${id}`): Dag => ({
	...before,
	commits: [
		...before.commits,
		{
			id,
			message,
			files: message.startsWith("chore")
				? { "README.md": id }
				: { [`packages/a/${id}.ts`]: id },
		},
	],
});

const tip = (d: Dag) => d.commits.at(-1)?.id ?? "";

const push = (before: string) => ({ name: "push", payload: { before } });

/** Replaces the marker of prerelease PR #2 with one planned at `head` releasing `version`. */
const tamper = (remote: MemoryRemote, head: string, version: string) => {
	Object.assign(remote.prs[1] ?? {}, {
		body: encodeMarker({
			head,
			releaseCommit: remote.prs[1]?.headSha ?? "",
			releases: [{ id: "a", version, tag: `a-v${version}` }],
		}),
	});
};

/** Remote with `main` at the dag's HEAD and the release PRs opened by `pr`. */
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

	const opened = await cli(["pr"], start);

	const merge = (before: Dag, number: number): Dag => {
		const merged = mergePr(before, remote, number);
		remote.branches.set("main", tip(merged));

		return merged;
	};

	const land = (before: Dag, id: string, message?: string): Dag => {
		const next = commit(before, id, message);
		remote.branches.set("main", id);

		return next;
	};

	/** `run --github-output --out` at `runDag`: the result, plan and release list. */
	const run = async (runDag: Dag, args: string[], opts: RunOptions = {}) => {
		const dir = tmpDir("cut");
		const out = join(dir, "plan.json");
		const githubOutput = join(dir, "output");
		writeFileSync(githubOutput, "");
		const result = await cli(
			["run", "--github-output", "--out", out, ...args],
			runDag,
			{ ...opts, env: { GITHUB_OUTPUT: githubOutput, ...opts.env } },
		);
		const line = readFileSync(githubOutput, "utf8")
			.split("\n")
			.find((l) => l.startsWith("releases="));

		return {
			...result,
			plan:
				result.code === 0
					? planSchema.parse(JSON.parse(readFileSync(out, "utf8")))
					: undefined,
			releases: z
				.array(releaseEntrySchema)
				.parse(JSON.parse(line?.slice("releases=".length) ?? "[]")),
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

	return { remote, runs, cli, opened, merge, land, run, twice };
};

describe("prerelease PRs", () => {
	it("opens the release PR and a changelog-only prerelease PR (E38)", async () => {
		const { remote, opened } = await setup();

		expect(opened).toEqual({
			code: 0,
			stdout: [
				`created PR #1 ${SHARED}: chore(release): main`,
				`created PR #2 ${CUT}: chore(release): main beta`,
				"",
			].join("\n"),
			stderr: "",
		});
		const cut = remote.prs[1];
		expect(decodeMarker(cut?.body ?? "")).toEqual({
			head: "c1",
			releaseCommit: cut?.headSha,
			releases: [{ id: "a", version: "1.1.0-beta.2", tag: "a-v1.1.0-beta.2" }],
		});
		expect(remote.commits.get(cut?.headSha ?? "")).toMatchObject({
			parent: "c1",
			message: "chore(release): main beta",
			files: { "packages/a/CHANGELOG.md": expect.any(String) },
		});
		expect(
			Object.keys(remote.commits.get(cut?.headSha ?? "")?.files ?? {}),
		).toEqual(["packages/a/CHANGELOG.md"]);
		expect(cut?.body).toContain(
			"<details><summary>a: 1.1.0-beta.2</summary>\n\n## [1.1.0-beta.2](https://github.com/acme/repo/compare/a-v1.0.0...a-v1.1.0-beta.2) (2026-10-15)",
		);
	});

	it("tags a merged prerelease PR as a non-latest prerelease and lists only the cut (E39, E46, E50)", async () => {
		const { remote, runs, merge, twice } = await setup();
		runs.push("c1");
		const merged = merge(dag, 2);
		remote.calls.length = 0;

		const [first, second] = await twice(merged, [], { event: push("c1") });
		expect(first.code).toBe(0);
		expect(first.stdout).toMatch(
			/^PR #2: tagged a-v1\.1\.0-beta\.2 at merge-2\nPR #2: created releases a-v1\.1\.0-beta\.2\nPR #2: labelled released\nupdated PR #1 tallyrelease\/release\/main\/shared: chore\(release\): main\n/u,
		);
		expect(remote.tags).toEqual(new Map([["a-v1.1.0-beta.2", "merge-2"]]));
		expect(remote.releases).toEqual([
			{
				id: 1,
				tag: "a-v1.1.0-beta.2",
				name: "a: v1.1.0-beta.2",
				body: expect.stringMatching(
					/^## \[1\.1\.0-beta\.2\]\(https:\/\/github\.com\/acme\/repo\/compare\/a-v1\.0\.0\.\.\.a-v1\.1\.0-beta\.2\) \(2026-10-15\)\n\n\n### Features\n\n\* \*\*a:\*\* add a/u,
				),
				makeLatest: false,
				prerelease: true,
			},
		]);
		expect(first.plan?.released).toEqual([
			{
				id: "a",
				path: "packages/a",
				version: "1.1.0-beta.2",
				tag: "a-v1.1.0-beta.2",
				floatingTags: [],
				releaseSha: "merge-2",
				catchUp: false,
				forge: {
					pr: { number: 2, url: "pull/2" },
					release: { url: "release/a-v1.1.0-beta.2" },
				},
				line: "default",
				prerelease: true,
				latest: false,
			},
		]);
		// The cut, and no build entry for a unit cut at HEAD.
		expect(first.releases).toMatchObject([
			{
				id: "a",
				kind: "prerelease",
				version: "1.1.0-beta.2",
				channel: "beta",
				tag: "a-v1.1.0-beta.2",
				releaseSha: "merge-2",
				latest: false,
				forge: { pr: { number: 2 } },
				changes: [{ sha: "c1", subject: "add a" }],
			},
		]);
		expect(first.releases).toHaveLength(1);
		// Nothing listed since the cut: no new prerelease PR (E46).
		expect(remote.prs.filter((p) => p.state === "open")).toMatchObject([
			{ number: 1, head: SHARED },
		]);
		expect(second.stdout).toMatch(/^no merged release PRs\nPR #1 /u);
		expect(second.plan?.released).toEqual(first.plan?.released);
	});

	it("finishes a partially failed cut without the checks and with the same body (E50)", async () => {
		const { remote, runs, cli, merge } = await setup();
		const merged = merge(dag, 2);
		const gitWriter = fakeGitWriter(remote);
		const view = memoryRepo(merged, [remote.tags, gitWriter.tags]);
		const checked: [string, string][] = [];
		const git = {
			...view.git,
			isFirstParentAncestor: async (a: string, b: string) => {
				checked.push([a, b]);

				return await view.git.isFirstParentAncestor(a, b);
			},
		};
		const bodies: string[] = [];
		const failing = {
			...fakeForge(runs, remote),
			createRelease: async (_repo: unknown, { body }: { body: string }) => {
				bodies.push(body);

				return await Promise.reject(
					Object.assign(new Error("boom"), { status: 500 }),
				);
			},
		};
		expect(
			await cli(["release"], merged, { git, gitWriter, forge: failing }),
		).toMatchObject({ code: 1, stderr: expect.stringContaining("boom") });
		expect(remote.tags).toEqual(new Map([["a-v1.1.0-beta.2", "merge-2"]]));
		expect(checked).toContainEqual(["c1", "c1"]);
		checked.length = 0;

		const result = await cli(["release"], merged, { git, gitWriter });
		expect(result.stdout).toBe(
			"PR #2: created releases a-v1.1.0-beta.2\nPR #2: labelled released\n",
		);
		expect(checked).not.toContainEqual(["c1", "c1"]);
		expect(remote.tags).toEqual(new Map([["a-v1.1.0-beta.2", "merge-2"]]));
		expect(remote.releases).toMatchObject([
			{ tag: "a-v1.1.0-beta.2", prerelease: true, body: bodies[0] },
		]);
		expect(bodies[0]).toContain("add a");
	});

	it("tags a merge after unrelated and listed commits, with them in the release body (E40, E41)", async () => {
		const { remote, runs, land, merge, run } = await setup();
		runs.push("c1");
		const later = land(land(dag, "c2"), "c3", "fix(a): fix a");
		const merged = merge(later, 2);

		const result = await run(merged, [], { event: push("c1") });
		expect(result.stdout).toContain(
			"PR #2: tagged a-v1.1.0-beta.2 at merge-2\n",
		);
		expect(remote.tags.get("a-v1.1.0-beta.2")).toBe("merge-2");
		expect(remote.releases[0]?.body).toMatch(
			/### Features\n\n\* \*\*a:\*\* add a .*\n\n\n### Bug Fixes\n\n\* \*\*a:\*\* fix a /su,
		);
	});

	it("labels a prerelease PR with a tampered version stale (E42)", async () => {
		const { remote, run, merge } = await setup();
		tamper(remote, "c1", "1.1.0-beta.9");

		const merged = merge(dag, 2);
		const result = await run(merged, [], { event: push("c1") });
		expect(result.stdout).toContain(
			"PR #2: labelled stale: the plan at c1, its planned commit and the commit it was merged onto, no longer matches its marker\n",
		);
		expect(remote.tags.size).toBe(0);
		expect(remote.prs[1]?.labels).toEqual(["tallyrelease: stale"]);
	});

	it("labels a prerelease PR planned off the first-parent chain stale", async () => {
		const { remote, run, merge } = await setup();
		tamper(remote, "merge-2", "1.1.0-beta.2");

		const merged = merge(dag, 2);
		const result = await run(merged, [], { event: push("c1") });
		expect(result.stdout).toContain(
			"PR #2: labelled stale: its planned commit merge-2 is not on the first-parent chain of c1, the commit it was merged onto\n",
		);
		expect(remote.tags.size).toBe(0);
	});

	it("labels a prerelease PR whose tag exists elsewhere stale and goes on", async () => {
		const start: Dag = {
			...dag,
			tags: [...(dag.tags ?? []), { name: "a-v1.1.0-beta.2", commit: "c0" }],
		};
		const { remote, runs, merge, run } = await setup(start);
		runs.push("c1");
		const merged = merge(merge(start, 2), 1);

		const result = await run(merged, [], { event: push("c1") });
		expect(result.stdout).toMatch(
			/^PR #2: labelled stale: its tag a-v1\.1\.0-beta\.2 exists at c0\nPR #1: tagged a-v1\.1\.0 at merge-1\n/u,
		);
		expect(remote.tags).toEqual(new Map([["a-v1.1.0", "merge-1"]]));
	});

	for (const dryRun of [false, true]) {
		it(`sees the cut tags of the same ${dryRun ? "dry " : ""}run`, async () => {
			const { remote, cli, merge } = await setup();
			const first = merge(dag, 2);
			// A second merge of the same intent, then the release PR.
			remote.prs.push(
				...remote.prs.slice(1, 2).map((p) => ({ ...p, number: 3 })),
			);
			const merged = merge(merge(first, 3), 1);
			const verb = dryRun ? "would tag" : "tagged";

			const result = await cli(
				["release", ...(dryRun ? ["--dry-run"] : [])],
				merged,
			);
			expect(result).toMatchObject({ code: 0, stderr: "" });
			expect(result.stdout).toMatch(
				new RegExp(
					`^PR #2: ${verb} a-v1\\.1\\.0-beta\\.2 at merge-2\n(?:.*\n)*PR #3: ${dryRun ? "would label" : "labelled"} stale: its planned commit c1 predates the latest prerelease tag\nPR #1: ${verb} a-v1\\.1\\.0 at merge-1\n`,
					"u",
				),
			);
		});
	}

	it("labels a prerelease PR planned before the latest cut stale and goes on (E43)", async () => {
		const { remote, runs, merge, run } = await setup();
		runs.push("c1");
		const merged = merge(dag, 2);
		await run(merged, [], { event: push("c1") });

		// A second merge of the same intent, then the release PR.
		remote.prs.push(
			...remote.prs.slice(1, 2).map((p) => ({
				...p,
				number: 3,
				state: "open" as const,
				labels: ["tallyrelease: pending"],
				mergedAt: null,
				mergeCommitSha: null,
			})),
		);

		const again = merge(merged, 3);
		const released = merge(again, 1);
		const result = await run(released, [], { event: push("merge-2") });
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(
			/^PR #3: labelled stale: its planned commit c1 predates the latest prerelease tag\nPR #1: tagged a-v1\.1\.0 at merge-1\n/u,
		);
		expect(remote.tags).toEqual(
			new Map([
				["a-v1.1.0-beta.2", "merge-2"],
				["a-v1.1.0", "merge-1"],
			]),
		);
	});

	it("leaves the prerelease PR untouched on an unrelated push and rebuilds it on a new change (E44, E45)", async () => {
		const { remote, cli, land } = await setup();
		const cut = remote.prs[1];
		const { headSha, body } = { ...cut };
		const unrelated = land(dag, "c2");

		const kept = await cli(["pr"], unrelated);
		expect(kept.stdout).toBe(
			[
				`updated PR #1 ${SHARED}: chore(release): main`,
				`PR #2 ${CUT} is up to date`,
				"",
			].join("\n"),
		);
		expect(remote.branches.get(CUT)).toBe(headSha);
		expect(cut).toMatchObject({ headSha, body });

		const changed = land(unrelated, "c3", "feat(a): more a");
		const rebuilt = await cli(["pr"], changed);
		expect(rebuilt.stdout).toContain(
			`updated PR #2 ${CUT}: chore(release): main beta\n`,
		);
		expect(remote.branches.get(CUT)).not.toBe(headSha);
		expect(decodeMarker(cut?.body ?? "")).toMatchObject({
			head: "c3",
			releases: [{ version: "1.1.0-beta.4" }],
		});
		expect(cut?.body).toContain("more a");
	});

	it("labels a prerelease PR merged after the release PR stale (E47)", async () => {
		const { remote, runs, merge, run } = await setup();
		runs.push("c1");
		const merged = merge(merge(dag, 1), 2);

		const result = await run(merged, [], { event: push("c1") });
		expect(result.stdout).toMatch(
			/^PR #1: tagged a-v1\.1\.0 at merge-1\n.*PR #2: labelled stale: its prereleases differ from the plan at c1, its planned commit, or their release changed by merge-1, the commit it was merged onto\n/su,
		);
		expect(remote.tags).toEqual(new Map([["a-v1.1.0", "merge-1"]]));
	});

	it("closes the prerelease PR and deletes its branch after a release (E48)", async () => {
		const { remote, runs, merge, run } = await setup();
		runs.push("c1");
		const lease = remote.branches.get(CUT);
		const merged = merge(dag, 1);

		const result = await run(merged, [], { event: push("c1") });
		expect(result.stdout).toContain(`closed PR #2 ${CUT}\n`);
		expect(remote.prs[1]?.state).toBe("closed");
		expect(remote.branches.has(CUT)).toBe(false);
		expect(remote.calls).toContainEqual([
			"push",
			[`:refs/heads/${CUT}`],
			{ leases: { [`refs/heads/${CUT}`]: lease }, token: "t" },
		]);
	});

	it("lists a cut tagged by a later run as a catch-up (E49)", async () => {
		const { runs, merge, land, run } = await setup();
		runs.push("c1");
		// The run at merge-2 was cancelled.
		const later = land(merge(dag, 2), "c3");

		const result = await run(later, [], { event: push("merge-2") });
		expect(result.stdout).toContain(
			"PR #2: tagged a-v1.1.0-beta.2 at merge-2\n",
		);
		expect(result.releases).toMatchObject([
			{
				id: "a",
				kind: "prerelease",
				channel: "beta",
				tag: "a-v1.1.0-beta.2",
				releaseSha: "merge-2",
				catchUp: true,
			},
			{ id: "a", kind: "prerelease", channel: "alpha", tag: null },
		]);
	});

	it("sees the tags of a dry run (E51)", async () => {
		const { remote, runs, merge, twice } = await setup();
		runs.push("c1");
		const merged = merge(dag, 2);
		remote.calls.length = 0;

		const [first, second] = await twice(merged, ["--dry-run"], {
			event: push("c1"),
		});
		expect(first.stdout).toMatch(
			/^PR #2: would tag a-v1\.1\.0-beta\.2 at merge-2\nPR #2: would create releases a-v1\.1\.0-beta\.2\nPR #2: would label released\ncommit as .*\nwould push tallyrelease\/release\/main\/shared\nwould update PR #1 tallyrelease\/release\/main\/shared: chore\(release\): main\n/u,
		);
		expect(first.stdout).not.toContain(CUT);
		expect(first.plan?.released).toMatchObject([
			{ tag: "a-v1.1.0-beta.2", prerelease: true, forge: { release: null } },
		]);
		expect(second.stdout).toBe(first.stdout);
		expect(remote.calls).toEqual([]);
		expect(remote.tags.size).toBe(0);
	});

	it("warns W_CUT_SCHEME for a unit that cannot be cut (E52)", async () => {
		const start: Dag = {
			commits: [
				{
					id: "c0",
					files: {
						"tallyrelease.yaml": config.replace(
							"{ node: {} }",
							"{ node: {}, dart: {} }",
						),
						"package.json": json({ workspaces: ["packages/*"] }),
						"packages/a/package.json": json({ name: "@s/a", version: "1.0.0" }),
						"apps/app/pubspec.yaml":
							"name: app\npublish_to: none\nversion: 1.0.0+1\ndependencies:\n  flutter:\n    sdk: flutter\n",
					},
				},
				{
					id: "c1",
					message: "feat: add both",
					files: { "packages/a/x.ts": "1", "apps/app/x.dart": "1" },
				},
			],
			tags: [
				{ name: "a-v1.0.0", commit: "c0" },
				{ name: "app-v1.0.0+1", commit: "c0" },
			],
		};
		const { remote, opened } = await setup(start);

		expect(opened.stderr).toContain(
			'warning[W_CUT_SCHEME]: unit "app" (scheme flutter) cannot be cut on channel "beta"\n',
		);
		expect(decodeMarker(remote.prs[1]?.body ?? "")?.releases).toEqual([
			{ id: "a", version: "1.1.0-beta.2", tag: "a-v1.1.0-beta.2" },
		]);
	});
});
