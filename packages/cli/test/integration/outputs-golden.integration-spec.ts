import { afterAll, describe, expect, it } from "vitest";

import {
	fakeForge,
	fakeGitWriter,
	memoryRemote,
	mergePr,
} from "./harness/fake-forge.js";
import { removeTmpDirs } from "./harness/git-repo.js";
import { memoryRepo } from "./harness/memory-repo.js";
import { actionsEnv, runCli } from "./harness/run-cli.js";

import type { RunOptions } from "./harness/run-cli.js";
import type { Dag } from "@tallyrelease/core/testing";

afterAll(removeTmpDirs);

const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

const env = {
	...actionsEnv,
	GITHUB_TOKEN: "t",
	GITHUB_SERVER_URL: "https://github.com",
	GITHUB_OUTPUT: "/gh/output",
	GITHUB_STEP_SUMMARY: "/gh/summary.md",
	RUNNER_TEMP: "/gh/temp",
};

const config = `
plugins: { node: {} }
defaults: { release: true }
branches:
  - { name: main, line: default, channels: { build: beta } }
`;

/** Units a and b at 1.0.0 (tagged at c0), a feat on b; b-v1.0.5 at c1 was never published. */
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
		{ id: "c1", message: "chore: readme", files: { "README.md": "1" } },
		{ id: "c2", message: "feat(b): add b", files: { "packages/b/x.ts": "1" } },
	],
	tags: [
		{ name: "a-v1.0.0", commit: "c0" },
		{ name: "b-v1.0.0", commit: "c0" },
		{ name: "b-v1.0.5", commit: "c1" },
	],
};

const push = (before: string) => ({ name: "push", payload: { before } });

/** Runs the cli with in-memory files: appended and written files by path. */
const harness = () => {
	const remote = memoryRemote();
	remote.branches.set("main", "c2");
	const files = new Map<string, string>();
	const cli = async (args: string[], runDag: Dag, opts: RunOptions = {}) => {
		const gitWriter = fakeGitWriter(remote);

		return await runCli(args, {
			...memoryRepo(runDag, [remote.tags, gitWriter.tags]),
			forge: fakeForge(["c0"], remote),
			gitWriter,
			clock: () => new Date("2026-10-15T12:00:00Z"),
			appendFile: (path, content) => {
				files.set(path, (files.get(path) ?? "") + content);
			},
			writeOutFile: (path, content) => {
				files.set(path, content);
			},
			...opts,
			env: { ...env, ...opts.env },
		});
	};

	return { remote, files, cli };
};

/** File content with the random `$GITHUB_OUTPUT` delimiter replaced. */
const normalised = (content: string | undefined) =>
	(content ?? "").replace(/ghadelimiter_[0-9a-f-]{36}/g, "ghadelimiter_<uuid>");

describe("golden outputs", () => {
	it("affected --github-output on a push", async () => {
		const { files, cli } = harness();
		const result = await cli(["affected", "--github-output"], dag, {
			event: push("c1"),
		});
		expect(result).toMatchObject({ code: 0 });
		await expect(normalised(files.get(env.GITHUB_OUTPUT))).toMatchFileSnapshot(
			"goldens/affected.github-output",
		);
	});

	it("run --github-output --summary with a release, a catch-up and a prerelease", async () => {
		const { remote, files, cli } = harness();
		expect(await cli(["pr"], dag)).toMatchObject({ code: 0 });
		// A feat on a lands before the release PR of b merges.
		const merged = mergePr(
			{
				...dag,
				commits: [
					...dag.commits,
					{
						id: "c3",
						message: "feat(a): add a",
						files: { "packages/a/x.ts": "1" },
					},
				],
			},
			remote,
			1,
		);
		files.clear();

		const result = await cli(["run", "--github-output", "--summary"], merged, {
			event: push("c3"),
		});
		expect(result).toMatchObject({ code: 0 });
		await expect(normalised(files.get(env.GITHUB_OUTPUT))).toMatchFileSnapshot(
			"goldens/run.github-output",
		);
		await expect(files.get(env.GITHUB_STEP_SUMMARY)).toMatchFileSnapshot(
			"goldens/run.summary.md",
		);
	});

	it("plan --summary", async () => {
		const { files, cli } = harness();
		const result = await cli(["plan", "--summary"], dag, {
			event: push("c1"),
		});
		expect(result).toMatchObject({ code: 0 });
		await expect(files.get(env.GITHUB_STEP_SUMMARY)).toMatchFileSnapshot(
			"goldens/plan.summary.md",
		);
	});
});
