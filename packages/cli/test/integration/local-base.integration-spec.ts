import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createRepo, git, removeTmpDirs } from "./harness/git-repo.js";
import { runCli } from "./harness/run-cli.js";
import { affectedDocSchema } from "../../src/affected-schema.js";

import type { Env } from "../../src/ci/env.js";
import type { Dag } from "@tallyrelease/core/testing";

const dag: Dag = {
	commits: [
		{
			id: "c0",
			files: { "tallyrelease.yaml": "units:\n  a: {}\n", "a/x": "0" },
		},
		{ id: "c1", files: { "a/x": "1" } },
	],
};

const affected = async (cwd: string, env: Env = {}) => {
	const result = await runCli(["affected", "--json"], { cwd, env });
	expect(result).toMatchObject({ code: 0 });
	const doc = affectedDocSchema.parse(JSON.parse(result.stdout));

	return {
		base: doc.build.base,
		source: doc.build.baseSource,
		ids: doc.units.map((u) => u.id),
	};
};

afterAll(removeTmpDirs);

describe("local merge base (G29)", () => {
	it("diffs a feature branch against origin/HEAD outside CI", async () => {
		const { dir, sha } = createRepo(dag);
		git(dir, "update-ref", "refs/remotes/origin/main", sha("c0"));
		git(
			dir,
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
			"refs/remotes/origin/main",
		);
		git(dir, "checkout", "--quiet", "-b", "feature");
		writeFileSync(join(dir, "a/x"), "2");
		git(
			dir,
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"--quiet",
			"-am",
			"feature",
		);

		expect(await affected(dir)).toEqual({
			base: sha("c0"),
			source: "local-merge-base",
			ids: ["a"],
		});
		const text = await runCli(["affected"], { cwd: dir });
		expect(text.stdout.split("\n")[0]).toBe(
			`base  ${sha("c0").slice(0, 7)} (merge base with origin/main)`,
		);

		for (const env of [{ CI: "true" }, { JENKINS_URL: "http://ci" }]) {
			// eslint-disable-next-line no-await-in-loop -- sequential cases
			expect(await affected(dir, env)).toMatchObject({
				base: null,
				source: "none",
			});
		}

		expect(await affected(dir, { CI: "false" })).toMatchObject({
			source: "local-merge-base",
		});
	});

	it("diffs against the HEAD of --remote", async () => {
		const { dir, sha } = createRepo(dag);
		git(dir, "update-ref", "refs/remotes/upstream/main", sha("c0"));
		git(
			dir,
			"symbolic-ref",
			"refs/remotes/upstream/HEAD",
			"refs/remotes/upstream/main",
		);

		const text = await runCli(["affected", "--remote", "upstream"], {
			cwd: dir,
		});
		expect(text.stdout.split("\n")[0]).toBe(
			`base  ${sha("c0").slice(0, 7)} (merge base with upstream/main)`,
		);
	});

	it("uses local main without a remote, else builds everything", async () => {
		const { dir, sha } = createRepo(dag);
		expect(await affected(dir)).toEqual({
			base: sha("c1"),
			source: "local-merge-base",
			ids: [],
		});

		git(dir, "branch", "-m", "main", "trunk");
		expect(await affected(dir)).toEqual({
			base: null,
			source: "none",
			ids: ["a"],
		});
	});
});
