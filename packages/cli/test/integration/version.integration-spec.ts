import { memoryFs, memoryGit } from "@tallyrelease/core/testing";
import { describe, expect, it } from "vitest";

import { memoryRepo } from "./harness/memory-repo.js";
import { runCli } from "./harness/run-cli.js";

import type { RunOptions } from "./harness/run-cli.js";
import type { Dag } from "@tallyrelease/core/testing";

const config = ({
	line = ", channels: { build: beta }",
	cli = "",
	defaults = "",
} = {}) => `
plugins: { node: {} }
defaults: { release: true${defaults} }
units:
  packages/cli:${cli}
    versionFiles: [{ file: README.md, pattern: "npx @s/cli@{version}" }]
branches:
  - { name: main, line: default${line} }
`;

const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

const pkg = (name: string, version: string, core?: string) =>
	json({
		name: `@s/${name}`,
		version,
		...(core !== undefined && { dependencies: { "@s/core": core } }),
	});

/** cli pins core; a feat on core releases core 1.1.0 and cli 1.0.1. */
const repo = (yaml = config(), more: Dag["commits"] = []): Dag => ({
	commits: [
		{
			id: "c0",
			files: {
				"tallyrelease.yaml": yaml,
				"package.json": json({ workspaces: ["packages/*"] }),
				"packages/core/package.json": pkg("core", "1.0.0"),
				"packages/cli/package.json": pkg("cli", "1.0.0", "1.0.0"),
				"README.md": "Run `npx @s/cli@1.0.0 plan`.\n",
			},
		},
		{
			id: "c1",
			message: "feat(core): add api (#3)",
			files: { "packages/core/a.ts": "1" },
		},
		...more,
	],
	tags: [
		{ name: "core-v1.0.0", commit: "c0" },
		{ name: "cli-v1.0.0", commit: "c0" },
	],
});

/** Runs `version` over a mutable working tree. */
const setup = (dag: Dag = repo(), opts: RunOptions = {}) => {
	const files = memoryGit(dag).tree("HEAD");
	const before = { ...files };
	const version = async (args: string[] = []) =>
		await runCli(["version", ...args], {
			...memoryRepo(dag),
			fs: memoryFs(files),
			writeFile: (path, content) => {
				files[path] = content;
			},
			...opts,
		});

	return { files, before, version };
};

const none = { code: 0, stdout: "no version files to update\n", stderr: "" };

describe("version", () => {
	it("stamps the build prereleases, then is a no-op", async () => {
		const { files, version } = setup();
		expect(await version()).toEqual({
			code: 0,
			stdout: [
				"updated packages/core/package.json\n",
				"updated packages/cli/package.json\n",
				"updated README.md\n",
			].join(""),
			stderr: "",
		});
		expect(files["packages/core/package.json"]).toBe(
			pkg("core", "1.1.0-beta.1"),
		);
		expect(files["packages/cli/package.json"]).toBe(
			pkg("cli", "1.0.1-beta.1", "1.1.0-beta.1"),
		);
		expect(files["README.md"]).toBe("Run `npx @s/cli@1.0.1-beta.1 plan`.\n");
		expect(files).not.toHaveProperty(["packages/core/CHANGELOG.md"]);

		const after = { ...files };
		expect(await version()).toEqual(none);
		expect(files).toEqual(after);
	});

	it("prints the files without writing them with --dry-run", async () => {
		const { files, before, version } = setup();
		expect((await version(["--dry-run"])).stdout).toBe(
			[
				"would update packages/core/package.json\n",
				"would update packages/cli/package.json\n",
				"would update README.md\n",
			].join(""),
		);
		expect(files).toEqual(before);
	});

	it("stamps nothing at an untagged release merge", async () => {
		const { files, before, version } = setup(
			repo(config(), [
				{
					id: "c2",
					message: "chore: release main",
					files: {
						"packages/core/package.json": pkg("core", "1.1.0"),
						"packages/cli/package.json": pkg("cli", "1.0.1", "1.1.0"),
						"README.md": "Run `npx @s/cli@1.0.1 plan`.\n",
					},
				},
			]),
		);
		expect(await version()).toEqual(none);
		expect(files).toEqual(before);
	});

	it("stamps nothing at a tagged release", async () => {
		const dag = repo(config(), [
			{
				id: "c2",
				message: "chore: release main",
				files: {
					"packages/core/package.json": pkg("core", "1.1.0"),
					"packages/cli/package.json": pkg("cli", "1.0.1", "1.1.0"),
				},
			},
		]);
		dag.tags?.push(
			{ name: "core-v1.1.0", commit: "c2" },
			{ name: "cli-v1.0.1", commit: "c2" },
		);
		const { files, before, version } = setup(dag);
		expect(await version()).toEqual(none);
		expect(files).toEqual(before);
	});

	it("stamps nothing on a line without a build channel", async () => {
		const { files, before, version } = setup(repo(config({ line: "" })));
		expect(await version()).toEqual(none);
		expect(files).toEqual(before);
	});

	it("stamps the template of a tag-versioned unit", async () => {
		const { files, before, version } = setup(
			repo(config({ cli: "\n    version: tag" })),
		);
		expect((await version()).stdout).toBe(
			"updated packages/core/package.json\nupdated README.md\n",
		);
		expect(files["packages/cli/package.json"]).toBe(
			before["packages/cli/package.json"],
		);
		expect(files["README.md"]).toBe("Run `npx @s/cli@1.0.1-beta.1 plan`.\n");
	});

	it("keeps a merged separate release and stamps the pending one", async () => {
		const cli = pkg("cli", "1.1.0", "1.0.0");
		const yaml = config({
			cli: "\n    propagate: rebuild",
			defaults: ", releasePr: separate",
		});
		const { files, version } = setup(
			repo(yaml, [
				{
					id: "c2",
					message: "feat(cli): add flag",
					files: { "packages/cli/a.ts": "1" },
				},
				{
					id: "c3",
					message: "chore: release cli",
					files: { "packages/cli/package.json": cli },
				},
			]),
		);
		expect((await version()).stdout).toBe(
			"updated packages/core/package.json\n",
		);
		expect(files["packages/core/package.json"]).toBe(
			pkg("core", "1.1.0-beta.3"),
		);
		expect(files["packages/cli/package.json"]).toBe(cli);
	});

	it("stamps the prerelease of a fixed group into every member", async () => {
		const yaml = config().replace(
			"branches:",
			"groups:\n  sdk: { units: [core, cli] }\nbranches:",
		);
		const { files, version } = setup(repo(yaml));
		await version();
		expect(files["packages/core/package.json"]).toBe(
			pkg("core", "1.1.0-beta.1"),
		);
		expect(files["packages/cli/package.json"]).toBe(
			pkg("cli", "1.1.0-beta.1", "1.1.0-beta.1"),
		);
	});

	it("does nothing on pull request events", async () => {
		const { files, before, version } = setup(repo(), {
			event: { name: "pull_request", payload: {} },
		});
		expect(await version()).toEqual({
			code: 0,
			stdout: "",
			stderr:
				"warning[W_EFFECT_SKIPPED]: version does nothing on pull_request events\n",
		});
		expect(files).toEqual(before);
	});

	it("fails in a shallow clone", async () => {
		const dag = repo();
		const memory = memoryRepo(dag);
		const { files, before, version } = setup(dag, {
			git: { ...memory.git, isShallow: () => true },
		});
		expect(await version()).toMatchObject({
			code: 1,
			stderr: expect.stringContaining("error[E_BUILD_NUMBER_SHALLOW]"),
		});
		expect(files).toEqual(before);
	});
});
