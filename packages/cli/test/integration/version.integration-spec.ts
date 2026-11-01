import { memoryFs, memoryGit } from "@tallyrelease/core/testing";
import { describe, expect, it } from "vitest";

import { memoryRepo } from "./harness/memory-repo.js";
import { runCli } from "./harness/run-cli.js";
import { versionText } from "../../src/render/version.js";

import type { RunOptions } from "./harness/run-cli.js";
import type { Dag } from "@tallyrelease/core/testing";

const config = `
plugins: { node: {} }
defaults: { release: true }
units:
  packages/cli:
    versionFiles: [{ file: README.md, pattern: "npx @s/cli@{version}" }]
branches:
  - { name: main, line: default }
`;

const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

/** cli pins core; a feat on core releases core 1.1.0 and cli 1.0.1. */
const dag: Dag = {
	commits: [
		{
			id: "c0",
			files: {
				"tallyrelease.yaml": config,
				"package.json": json({ workspaces: ["packages/*"] }),
				"packages/core/package.json": json({
					name: "@s/core",
					version: "1.0.0",
				}),
				"packages/cli/package.json": json({
					name: "@s/cli",
					version: "1.0.0",
					dependencies: { "@s/core": "1.0.0" },
				}),
				"README.md": "Run `npx @s/cli@1.0.0 plan`.\n",
			},
		},
		{
			id: "c1",
			message: "feat(core): add api (#3)",
			files: { "packages/core/a.ts": "1" },
		},
	],
	tags: [
		{ name: "core-v1.0.0", commit: "c0" },
		{ name: "cli-v1.0.0", commit: "c0" },
	],
};

/** Runs `version` over a mutable working tree. */
const setup = (opts: RunOptions = {}) => {
	const files = memoryGit(dag).tree("HEAD");
	const before = { ...files };
	const version = async (args: string[] = []) =>
		await runCli(["version", ...args], {
			...memoryRepo(dag),
			fs: memoryFs(files),
			writeFile: (path, content) => {
				files[path] = content;
			},
			deleteFile: (path) => {
				Reflect.deleteProperty(files, path);
			},
			clock: () => new Date("2026-10-15T23:30:00Z"),
			env: {
				GITHUB_SERVER_URL: "https://github.com",
				GITHUB_REPOSITORY: "acme/repo",
			},
			...opts,
		});

	return { files, before, version };
};

const updated = [
	"packages/core/package.json",
	"packages/core/CHANGELOG.md",
	"packages/cli/package.json",
	"README.md",
	"packages/cli/CHANGELOG.md",
];

describe("version", () => {
	it("writes package.json and CHANGELOG.md, then is a no-op (E01, E28)", async () => {
		const { files, version } = setup();
		expect(await version()).toEqual({
			code: 0,
			stdout: updated.map((p) => `updated ${p}\n`).join(""),
			stderr: "",
		});
		expect(JSON.parse(files["packages/cli/package.json"] ?? "")).toEqual({
			name: "@s/cli",
			version: "1.0.1",
			dependencies: { "@s/core": "1.1.0" },
		});
		expect(files["packages/core/CHANGELOG.md"]).toBe(
			[
				"# Changelog",
				"",
				"## [1.1.0](https://github.com/acme/repo/compare/core-v1.0.0...core-v1.1.0) (2026-10-15)",
				"",
				"",
				"### Features",
				"",
				"* **core:** add api ([#3](https://github.com/acme/repo/issues/3)) ([c1](https://github.com/acme/repo/commit/c1))",
				"",
			].join("\n"),
		);
		expect(files["packages/cli/CHANGELOG.md"]).toContain(
			"    * @s/core bumped to 1.1.0",
		);

		const after = { ...files };
		expect(await version()).toEqual({
			code: 0,
			stdout: "no version files to update\n",
			stderr: "",
		});
		expect(files).toEqual(after);
	});

	it("applies a README template (E22)", async () => {
		const { files, version } = setup();
		await version();
		expect(files["README.md"]).toBe("Run `npx @s/cli@1.0.1 plan`.\n");
		expect((await version()).stdout).toBe("no version files to update\n");
	});

	it("prints the files without writing them with --dry-run", async () => {
		const { files, before, version } = setup();
		expect(await version(["--dry-run"])).toEqual({
			code: 0,
			stdout: updated.map((p) => `would update ${p}\n`).join(""),
			stderr: "",
		});
		expect(files).toEqual(before);
	});

	it("lists deleted paths after updated ones", () => {
		expect(versionText(["README.md"], [".changeset/a.md"], true)).toBe(
			"would update README.md\nwould delete .changeset/a.md\n",
		);
		expect(versionText([], [".changeset/a.md"], false)).toBe(
			"deleted .changeset/a.md\n",
		);
	});

	it("does nothing on pull request events", async () => {
		const { files, before, version } = setup({
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
});
