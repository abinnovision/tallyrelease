import { decodeMarker } from "@tallyrelease/core";
import { memoryFs, memoryGit } from "@tallyrelease/core/testing";
import { describe, expect, it } from "vitest";

import {
	fakeForge,
	fakeGitWriter,
	memoryRemote,
} from "./harness/fake-forge.js";
import { memoryRepo } from "./harness/memory-repo.js";
import { runCli } from "./harness/run-cli.js";
import { releasePrs } from "../../src/commands/pr.js";
import { createSession } from "../../src/session.js";

import type { RunOptions } from "./harness/run-cli.js";
import type { RepoRef } from "../../src/index.js";
import type { Dag } from "@tallyrelease/core/testing";

const SHARED = "tallyrelease/release/main/shared";

const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

const config = (extra = "") => `
plugins: { node: {} }
defaults: { release: true }
branches:
  - { name: main, line: default }
${extra}`;

/** Units `a`, `b`, `c` at 1.0.0, then one feat on each of `ids`. */
const repo = (yaml: string, ids = ["a", "b"]): Dag => ({
	commits: [
		{
			id: "c0",
			files: {
				"tallyrelease.yaml": yaml,
				"package.json": json({ workspaces: ["packages/*"] }),
				...Object.fromEntries(
					["a", "b", "c"].map((id) => [
						`packages/${id}/package.json`,
						json({ name: `@s/${id}`, version: "1.0.0" }),
					]),
				),
			},
		},
		...ids.map((id, i) => ({
			id: `c${String(i + 1)}`,
			message: `feat(${id}): add ${id}`,
			files: { [`packages/${id}/x.ts`]: "1" },
		})),
	],
	tags: ["a", "b", "c"].map((id) => ({ name: `${id}-v1.0.0`, commit: "c0" })),
});

/** Remote with `main` at HEAD; `pr` runs in-process, each run on a fresh repo view. */
const setup = (dag: Dag) => {
	const remote = memoryRemote();
	remote.branches.set("main", dag.commits.at(-1)?.id ?? "");
	const forge = fakeForge([], remote);
	const gitWriter = fakeGitWriter(remote);
	const pr = async (
		args: string[] = [],
		opts: RunOptions & { day?: string; dag?: Dag } = {},
	) => {
		const { day = "2026-10-15", dag: runDag = dag, env, ...rest } = opts;

		return await runCli(["pr", ...args], {
			...memoryRepo(runDag, [remote.tags]),
			forge,
			gitWriter,
			clock: () => new Date(`${day}T12:00:00Z`),
			...rest,
			env: {
				GITHUB_TOKEN: "t",
				GITHUB_SERVER_URL: "https://github.com",
				GITHUB_REPOSITORY: "acme/repo",
				...env,
			},
		});
	};

	const methods = () => remote.calls.map(([method]) => method);
	const files = (branch: string) =>
		Object.keys(
			remote.commits.get(remote.branches.get(branch) ?? "")?.files ?? {},
		).sort();

	return { remote, forge, pr, methods, files };
};

/** Same HEAD and files except the config. */
const withConfig = (dag: Dag, yaml: string) => ({
	fs: memoryFs({ ...memoryGit(dag).tree("HEAD"), "tallyrelease.yaml": yaml }),
});

describe("pr", () => {
	it("creates the shared PR with an empty lease, then is a no-op (E02)", async () => {
		const dag = repo(config());
		const { remote, pr, methods, files } = setup(dag);

		expect(await pr()).toEqual({
			code: 0,
			stdout: `created PR #1 ${SHARED}: chore(release): main\n`,
			stderr: "",
		});
		const sha = remote.branches.get(SHARED) ?? "";
		expect(remote.calls[0]).toEqual([
			"push",
			[`${sha}:refs/heads/${SHARED}`],
			{
				atomic: true,
				leases: { [`refs/heads/${SHARED}`]: "" },
				token: "t",
			},
		]);
		expect(remote.commits.get(sha)).toMatchObject({
			parent: "c2",
			message: "chore(release): main",
		});
		expect(files(SHARED)).toEqual([
			"packages/a/CHANGELOG.md",
			"packages/a/package.json",
			"packages/b/CHANGELOG.md",
			"packages/b/package.json",
		]);

		const [created] = remote.prs;
		expect(created).toMatchObject({
			number: 1,
			head: SHARED,
			base: "main",
			headSha: sha,
			labels: ["tallyrelease: pending"],
		});
		expect(decodeMarker(created?.body ?? "")).toEqual({
			head: "c2",
			releaseCommit: sha,
			releases: [
				{ id: "a", version: "1.1.0", tag: "a-v1.1.0" },
				{ id: "b", version: "1.1.0", tag: "b-v1.1.0" },
			],
		});
		expect(created?.body).toContain(
			"<details><summary>a: 1.1.0</summary>\n\n## [1.1.0](https://github.com/acme/repo/compare/a-v1.0.0...a-v1.1.0) (2026-10-15)",
		);

		const calls = methods();
		expect(calls).toEqual(["push", "createPr", "setLabel"]);
		expect(await pr()).toEqual({
			code: 0,
			stdout: `PR #1 ${SHARED} is up to date\n`,
			stderr: "",
		});
		expect(methods()).toEqual(calls);
	});

	it("truncates the body of 200 units below 60,000 characters (E02)", async () => {
		const ids = Array.from({ length: 200 }, (_, i) => `u${String(i)}`);
		const dag: Dag = {
			commits: [
				{
					id: "c0",
					files: {
						"tallyrelease.yaml": config(),
						"package.json": json({ workspaces: ["packages/*"] }),
						...Object.fromEntries(
							ids.map((id) => [
								`packages/${id}/package.json`,
								json({ name: `@s/${id}`, version: "1.0.0" }),
							]),
						),
					},
				},
				{
					id: "c1",
					message: `feat: ${"long subject ".repeat(10)}`,
					files: Object.fromEntries(
						ids.map((id) => [`packages/${id}/x.ts`, "1"]),
					),
				},
			],
			tags: ids.map((id) => ({ name: `${id}-v1.0.0`, commit: "c0" })),
		};
		const { remote, pr } = setup(dag);

		expect((await pr()).code).toBe(0);
		const body = remote.prs[0]?.body ?? "";
		expect(body.length).toBeLessThan(60_000);
		expect(body).toContain("_The changelog is truncated;");
		expect(decodeMarker(body)?.releases).toHaveLength(200);
		const title = "chore(release): main";
		expect(remote.prs[0]?.title).toBe(title);
		expect(remote.commits.get(remote.prs[0]?.headSha ?? "")?.message).toBe(
			title,
		);
		expect((await pr()).stdout).toBe(`PR #1 ${SHARED} is up to date\n`);
	});

	it("pushes once on the next day, then is a no-op (E06)", async () => {
		const { remote, pr, methods } = setup(repo(config()));
		await pr();
		const first = remote.branches.get(SHARED) ?? "";
		expect(await pr()).toMatchObject({ code: 0, stderr: "" });

		const calls = methods().length;
		expect((await pr([], { day: "2026-10-16" })).stdout).toBe(
			`updated PR #1 ${SHARED}: chore(release): main\n`,
		);
		const second = remote.branches.get(SHARED) ?? "";
		expect(second).not.toBe(first);
		expect(remote.calls.slice(calls)).toEqual([
			[
				"push",
				[`${second}:refs/heads/${SHARED}`],
				{
					atomic: true,
					leases: { [`refs/heads/${SHARED}`]: first },
					token: "t",
				},
			],
			["updatePr", 1, expect.anything()],
			["setLabel", 1, "tallyrelease: pending"],
		]);
		expect(remote.prs[0]?.body).toContain("(2026-10-16)");
		expect(decodeMarker(remote.prs[0]?.body ?? "")?.releaseCommit).toBe(second);

		const after = methods();
		expect((await pr([], { day: "2026-10-16" })).stdout).toBe(
			`PR #1 ${SHARED} is up to date\n`,
		);
		expect(methods()).toEqual(after);
	});

	it("does not edit the body when the push lease fails (E10)", async () => {
		const { remote, forge, pr } = setup(repo(config()));
		await pr();
		const body = remote.prs[0]?.body;
		const read = remote.branches.get(SHARED);
		// Someone else pushes after the branch was read.
		remote.branches.set(SHARED, "foreign");
		const racing = {
			...forge,
			branchSha: async (r: RepoRef, branch: string) =>
				branch === SHARED ? read : await forge.branchSha(r, branch),
		};

		expect(await pr([], { day: "2026-10-16", forge: racing })).toMatchObject({
			code: 1,
			stderr: expect.stringContaining("error[E_PUSH_LEASE]"),
		});
		expect(remote.prs[0]?.body).toBe(body);
	});

	it("closes the PR and deletes its branch when nothing is pending (E03)", async () => {
		const dag = repo(config());
		const { remote, pr, methods } = setup(dag);
		await pr();
		const sha = remote.branches.get(SHARED) ?? "";
		remote.tags.set("a-v1.1.0", "c2");
		remote.tags.set("b-v1.1.0", "c2");

		const calls = methods().length;
		expect(await pr()).toEqual({
			code: 0,
			stdout: `closed PR #1 ${SHARED}\n`,
			stderr: "",
		});
		expect(remote.calls.slice(calls)).toEqual([
			[
				"push",
				[`:refs/heads/${SHARED}`],
				{ leases: { [`refs/heads/${SHARED}`]: sha }, token: "t" },
			],
			["closePr", 1],
		]);
		expect(remote.prs[0]).toMatchObject({ state: "closed" });
		expect(remote.prs[0]?.comments).toHaveLength(1);
		expect(remote.branches.has(SHARED)).toBe(false);

		const after = methods();
		expect((await pr()).stdout).toBe("no release PRs\n");
		expect(methods()).toEqual(after);
	});

	it("opens one PR per separate item with only its files (E17)", async () => {
		const { remote, pr, methods, files } = setup(
			repo(
				config().replace(
					"{ release: true }",
					"{ release: true, releasePr: separate }",
				),
			),
		);
		const a = "tallyrelease/release/main/a";
		const b = "tallyrelease/release/main/b";

		expect((await pr()).stdout).toBe(
			[
				`created PR #1 ${a}: chore(release): a@1.1.0`,
				`created PR #2 ${b}: chore(release): b@1.1.0`,
				"",
			].join("\n"),
		);
		expect(files(a)).toEqual([
			"packages/a/CHANGELOG.md",
			"packages/a/package.json",
		]);
		expect(files(b)).toEqual([
			"packages/b/CHANGELOG.md",
			"packages/b/package.json",
		]);
		expect(decodeMarker(remote.prs[1]?.body ?? "")?.releases).toEqual([
			{ id: "b", version: "1.1.0", tag: "b-v1.1.0" },
		]);

		const calls = methods();
		await pr();
		expect(methods()).toEqual(calls);
	});

	it("pushes the shared and separate branches in one push (E18)", async () => {
		const yaml = `
plugins: { node: {} }
defaults: { release: true, releasePr: separate }
units:
  packages/b: { releasePr: shared }
  packages/c: { releasePr: shared }
branches:
  - { name: main, line: default }
`;
		const { remote, pr, methods, files } = setup(repo(yaml, ["a", "b", "c"]));

		expect((await pr()).stdout).toBe(
			[
				"created PR #1 tallyrelease/release/main/a: chore(release): a@1.1.0",
				`created PR #2 ${SHARED}: chore(release): main`,
				"",
			].join("\n"),
		);
		expect(remote.calls.filter(([m]) => m === "push")).toEqual([
			[
				"push",
				[
					`${remote.branches.get("tallyrelease/release/main/a") ?? ""}:refs/heads/tallyrelease/release/main/a`,
					`${remote.branches.get(SHARED) ?? ""}:refs/heads/${SHARED}`,
				],
				expect.objectContaining({ atomic: true }),
			],
		]);
		expect(files(SHARED)).toEqual([
			"packages/b/CHANGELOG.md",
			"packages/b/package.json",
			"packages/c/CHANGELOG.md",
			"packages/c/package.json",
		]);

		const calls = methods();
		await pr();
		expect(methods()).toEqual(calls);
	});

	it("keeps a separate group in one PR (E19)", async () => {
		const yaml = config(
			"groups:\n  g: { units: [a, b], releasePr: separate }\n",
		);
		const { remote, pr, methods, files } = setup(repo(yaml, ["a"]));
		const g = "tallyrelease/release/main/g";

		expect((await pr()).stdout).toBe(
			`created PR #1 ${g}: chore(release): g@1.1.0\n`,
		);
		expect(files(g)).toEqual([
			"packages/a/CHANGELOG.md",
			"packages/a/package.json",
			"packages/b/CHANGELOG.md",
			"packages/b/package.json",
		]);
		expect(decodeMarker(remote.prs[0]?.body ?? "")?.releases).toEqual([
			{ id: "a", version: "1.1.0", tag: "a-v1.1.0" },
			{ id: "b", version: "1.1.0", tag: "b-v1.1.0" },
		]);

		const calls = methods();
		await pr();
		expect(methods()).toEqual(calls);
	});

	it("suggests a maintenance branch for a major release only", async () => {
		const dag = repo(
			config('  - { name: "release/{major}.x", line: maintenance }\n'),
			["b"],
		);
		dag.commits.push({
			id: "c2",
			message: "feat(a)!: break a",
			files: { "packages/a/x.ts": "1" },
		});
		const { remote, pr } = setup(dag);

		expect((await pr()).code).toBe(0);
		const body = remote.prs[0]?.body ?? "";
		expect(body).toContain(
			"**Maintenance line for a 1.x.** This PR releases a new major. To keep shipping fixes for 1.x, cut the maintenance branch from the last 1.x release (also possible later):\n\n```\ngit push origin a-v1.0.0:refs/heads/release/1.x\n```\n\n",
		);
		expect(body.match(/Maintenance line/gu)).toHaveLength(1);
		expect(decodeMarker(body)?.releases).toHaveLength(2);
	});

	it("moves an item between its own PR and the shared PR (E20)", async () => {
		const separate = config("units:\n  packages/a: { releasePr: separate }\n");
		const dag = repo(separate);
		const { remote, pr, methods } = setup(dag);
		const a = "tallyrelease/release/main/a";

		expect((await pr()).stdout).toBe(
			[
				`created PR #1 ${a}: chore(release): a@1.1.0`,
				`created PR #2 ${SHARED}: chore(release): main`,
				"",
			].join("\n"),
		);

		const shared = withConfig(dag, config());
		expect((await pr([], shared)).stdout).toBe(
			[
				`updated PR #2 ${SHARED}: chore(release): main`,
				`closed PR #1 ${a}`,
				"",
			].join("\n"),
		);
		expect(remote.prs[0]).toMatchObject({ state: "closed" });
		expect(remote.branches.has(a)).toBe(false);
		let calls = methods();
		await pr([], shared);
		expect(methods()).toEqual(calls);

		expect((await pr()).stdout).toBe(
			[
				`created PR #3 ${a}: chore(release): a@1.1.0`,
				`updated PR #2 ${SHARED}: chore(release): main`,
				"",
			].join("\n"),
		);
		calls = methods();
		await pr();
		expect(methods()).toEqual(calls);
	});

	it("prints the actions without effects with --dry-run (E27)", async () => {
		const { remote, pr } = setup(repo(config()));

		expect(await pr(["--dry-run"])).toEqual({
			code: 0,
			stdout: `commit as tallyrelease <tallyrelease@users.noreply.github.com>\nwould push ${SHARED}\nwould create PR ${SHARED}: chore(release): main\n`,
			stderr: "",
		});
		expect(remote.calls).toEqual([]);
		expect(remote.prs).toEqual([]);

		await pr();
		remote.tags.set("a-v1.1.0", "c2");
		remote.calls.length = 0;
		expect((await pr(["--dry-run"])).stdout).toBe(
			[
				"commit as tallyrelease <tallyrelease@users.noreply.github.com>",
				`would push ${SHARED}`,
				`would update PR #1 ${SHARED}: chore(release): main`,
				"",
			].join("\n"),
		);
		expect(remote.calls).toEqual([]);
	});

	it("reports pushes to --remote with --dry-run", async () => {
		const { pr } = setup(repo(config()));

		expect((await pr(["--remote", "upstream", "--dry-run"])).stdout).toContain(
			`\nwould push ${SHARED} to upstream\n`,
		);
	});

	it("prints the commit identity from the git variables with --dry-run", async () => {
		const { pr } = setup(repo(config()));

		expect(
			(
				await pr(["--dry-run"], {
					env: {
						GIT_AUTHOR_NAME: "abi-jarvis[bot]",
						GIT_AUTHOR_EMAIL: "1+abi-jarvis[bot]@users.noreply.github.com",
					},
				})
			).stdout,
		).toMatch(
			/^commit as abi-jarvis\[bot\] <1\+abi-jarvis\[bot\]@users\.noreply\.github\.com>\nwould push /u,
		);
	});

	it("labels an unlabelled open PR after a failed label call", async () => {
		const { remote, forge, pr, methods } = setup(repo(config()));
		const failing = {
			...forge,
			setLabel: async () => {
				await Promise.reject(new Error("label failed"));
			},
		};
		expect(await pr([], { forge: failing })).toMatchObject({
			code: 1,
			stderr: expect.stringContaining("label failed"),
		});
		expect(remote.prs[0]?.labels).toEqual([]);

		expect((await pr()).stdout).toBe(
			`updated PR #1 ${SHARED}: chore(release): main\n`,
		);
		expect(remote.prs).toHaveLength(1);
		expect(remote.prs[0]?.labels).toEqual(["tallyrelease: pending"]);
		expect(methods().slice(-2)).toEqual(["createPr", "setLabel"]);

		const calls = methods();
		expect((await pr()).stdout).toBe(`PR #1 ${SHARED} is up to date\n`);
		expect(methods()).toEqual(calls);
	});

	it("closes the older of two open PRs on one branch", async () => {
		const { remote, pr, methods } = setup(repo(config()));
		await pr();
		remote.prs.push(
			...remote.prs.map((p) => ({ ...p, number: 2, comments: [] })),
		);

		expect((await pr()).stdout).toBe(
			[`PR #2 ${SHARED} is up to date`, `closed PR #1 ${SHARED}`, ""].join(
				"\n",
			),
		);
		expect(remote.branches.has(SHARED)).toBe(true);
		const calls = methods();
		expect((await pr()).stdout).toBe(`PR #2 ${SHARED} is up to date\n`);
		expect(methods()).toEqual(calls);
	});

	it("fails on a merged release PR that is not tagged yet (E32)", async () => {
		const { remote, pr, methods } = setup(repo(config()));
		await pr();
		Object.assign(remote.prs[0] ?? {}, {
			state: "closed",
			mergedAt: "2026-10-15T00:00:00Z",
			mergeCommitSha: "m1",
		});
		const calls = methods();

		expect(await pr()).toMatchObject({
			code: 1,
			stderr: expect.stringContaining(
				"error[E_PENDING_RECONCILE]: merged release PRs #1 are not tagged yet",
			),
		});
		expect(methods()).toEqual(calls);

		// `run` passes the PRs it reconciled.
		const dag = repo(config());
		let stdout = "";
		const session = createSession(
			{
				...memoryRepo(dag, [remote.tags]),
				forge: fakeForge([], remote),
				gitWriter: fakeGitWriter(remote),
				clock: () => new Date("2026-10-15T12:00:00Z"),
				env: {
					GITHUB_SERVER_URL: "https://github.com",
					GITHUB_REPOSITORY: "acme/repo",
				},
				cwd: "/work/repo",
				stdout: { write: (chunk: string) => (stdout += chunk) },
				stderr: { write: () => true },
			},
			{ config: "tallyrelease.yaml", token: "t" },
		);
		await releasePrs(session, { dryRun: true }, { reconciled: new Set([1]) });
		expect(stdout).toBe(
			`commit as tallyrelease <tallyrelease@users.noreply.github.com>\nwould create PR ${SHARED}: chore(release): main\n`,
		);
	});

	it("leaves release PRs alone when HEAD is behind the line tip (E33)", async () => {
		const { remote, pr } = setup(repo(config()));
		remote.branches.set("main", "newer");

		expect(await pr()).toEqual({
			code: 0,
			stdout: "",
			stderr: expect.stringContaining(
				'warning[W_PR_HEAD_BEHIND]: HEAD c2 is not the tip of "main" (newer)',
			),
		});
		expect(remote.calls).toEqual([]);
	});

	it("does nothing on pull request events and branches without a line rule", async () => {
		const { remote, pr } = setup(repo(config()));

		expect(
			await pr([], { event: { name: "pull_request", payload: {} } }),
		).toEqual({
			code: 0,
			stdout: "",
			stderr:
				"warning[W_EFFECT_SKIPPED]: pr does nothing on pull_request events\n",
		});
		expect(await pr(["--branch", "feature"])).toEqual({
			code: 0,
			stdout: "",
			stderr:
				'warning[W_EFFECT_SKIPPED]: pr does nothing on branch "feature" without a line rule\n',
		});
		expect(remote.calls).toEqual([]);
	});

	it("needs a forge token (E_NO_FORGE)", async () => {
		const { pr } = setup(repo(config()));

		expect(await pr([], { env: { GITHUB_TOKEN: undefined } })).toMatchObject({
			code: 1,
			stderr: expect.stringContaining("error[E_NO_FORGE]"),
		});
	});
});
