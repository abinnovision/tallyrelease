import { Ajv2020 } from "ajv/dist/2020.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createRepo, git, removeTmpDirs, tmpDir } from "./harness/git-repo.js";
import { memoryRepo } from "./harness/memory-repo.js";
import { runCli } from "./harness/run-cli.js";
import { affectedDocSchema } from "../../src/affected-schema.js";
import { gitTreeFs, nodeFs } from "../../src/fs-ctx.js";
import { planSchema } from "../../src/plan-schema.js";

import type { RunOptions } from "./harness/run-cli.js";
import type { Dag } from "@tallyrelease/core/testing";

const config = `
plugins: {}
units:
  libs/db: { id: db }
  libs/ui: { id: ui, release: true }
  apps/web: { id: web, release: true }
  apps/api: { id: api }
deps:
  - { from: db, to: ui }
  - { from: ui, to: web, pinned: true }
branches:
  - { name: main, line: default, channel: beta }
`;

/** ui and web released at p0; db is absorbed by ui; web pins ui. */
const dag: Dag = {
	commits: [
		{
			id: "p0",
			files: {
				"tallyrelease.yaml": config,
				"libs/db/a.ts": "0",
				"libs/ui/a.ts": "0",
				"apps/web/a.ts": "0",
				"apps/api/a.ts": "0",
			},
		},
		{ id: "p1", message: "fix: api", files: { "apps/api/a.ts": "1" } },
		{ id: "p2", message: "feat: db query", files: { "libs/db/a.ts": "2" } },
		{ id: "p3", message: "feat: ui button", files: { "libs/ui/a.ts": "3" } },
	],
	tags: [
		{ name: "ui-v1.0.0", commit: "p0" },
		{ name: "web-v1.0.0", commit: "p0" },
	],
};

const run = async (args: string[], opts: RunOptions = {}) =>
	await runCli(args, { ...memoryRepo(dag), ...opts });

const plan = async (args: string[], opts: RunOptions = {}) => {
	const result = await run(["plan", "--json", ...args], opts);
	expect(result).toMatchObject({ code: 0 });

	return planSchema.parse(JSON.parse(result.stdout));
};

afterAll(removeTmpDirs);

describe("plan", () => {
	it("prints a document valid against plan.schema.json (G26)", async () => {
		const doc = await plan(["--base", "p2"]);
		const validate = new Ajv2020({ strict: false }).compile(
			z.toJSONSchema(planSchema),
		);
		expect(validate(doc)).toBe(true);
		expect(doc).toMatchObject({
			line: { rule: "main", channel: "beta" },
			groups: [],
			released: [],
			warnings: [],
		});
		expect(doc.units).toMatchObject([
			{
				id: "ui",
				kind: "prerelease",
				baseTag: "ui-v1.0.0",
				from: "1.0.0",
				bump: "minor",
				next: "1.1.0",
				version: "1.1.0-beta.3",
				absorbedFrom: ["db"],
			},
			{
				id: "web",
				affected: { reason: "dependent", via: ["ui"] },
				kind: "prerelease",
				bump: "patch",
				propagatedFrom: ["ui"],
				next: "1.0.1",
			},
		]);

		const all = await plan(["--base", "p3", "--all"]);
		expect(all.units.map((u) => [u.id, u.kind])).toEqual([
			["ui", "none"],
			["web", "none"],
		]);
	});

	it("writes the plan path to $GITHUB_OUTPUT (G27)", async () => {
		const dir = tmpDir("out");
		const output = join(dir, "output");
		const env = { GITHUB_OUTPUT: output, RUNNER_TEMP: dir };
		const result = await run(["plan", "--json", "--github-output"], { env });
		expect(result.code).toBe(0);
		const path = join(dir, "tallyrelease-plan.json");
		expect(readFileSync(output, "utf8")).toBe(`plan=${path}\n`);
		expect(readFileSync(path, "utf8")).toBe(result.stdout);

		const out = join(dir, "custom.json");
		await run(["plan", "--out", out, "--github-output"], { env });
		expect(readFileSync(output, "utf8")).toBe(`plan=${path}\nplan=${out}\n`);
		expect(
			planSchema.parse(JSON.parse(readFileSync(out, "utf8"))),
		).toBeTruthy();

		const missing = await run(["plan", "--github-output"]);
		expect(missing.stderr).toMatch(/^error\[E_GITHUB_OUTPUT\]: /m);
	});

	it("prints a table and matches affected (G30)", async () => {
		const text = await run(["plan", "--base", "p2"]);
		expect(text).toEqual({
			code: 0,
			stdout: [
				"branch  main (rule main, default line, channel beta)",
				"base    p2 (--base p2)",
				"",
				"UNIT  KIND        FROM   BUMP   NEXT   VERSION",
				"ui    prerelease  1.0.0  minor  1.1.0  1.1.0-beta.3",
				"web   prerelease  1.0.0  patch  1.0.1  1.0.1-beta.3",
				"",
				"2 units planned: 2 prerelease",
				"",
			].join("\n"),
			stderr: "",
		});

		const noRule = await plan(["--base", "p0", "--branch", "feature"]);
		expect(noRule.line).toBeNull();
		expect(noRule.warnings.map((w) => w.code)).toEqual(["W_NO_BRANCH_RULE"]);
		expect(noRule.units.find((u) => u.id === "api")).toMatchObject({
			kind: "rebuild",
			next: null,
		});
		expect(noRule.units.find((u) => u.id === "ui")).toMatchObject({
			kind: "rebuild",
			next: "1.1.0",
			version: null,
		});

		for (const base of [
			[],
			["--base", "p0"],
			["--base", "p1"],
			["--base", "p3"],
		]) {
			// eslint-disable-next-line no-await-in-loop -- sequential cases
			const doc = await plan(base);
			// eslint-disable-next-line no-await-in-loop -- sequential cases
			const affected = await run(["affected", "--json", ...base]);
			const expected = affectedDocSchema.parse(JSON.parse(affected.stdout));
			expect(doc.branch).toBe(expected.branch);
			expect(doc.build).toEqual(expected.build);
			expect(
				doc.units
					.map((u) => [u.id, u.affected?.reason, u.affected?.via])
					.sort(),
			).toEqual(expected.units.map((u) => [u.id, u.reason, u.via]).sort());
		}
	});

	it("writes a markdown summary to $GITHUB_STEP_SUMMARY or stdout", async () => {
		const file = join(tmpDir("summary"), "summary.md");
		const stepped = await run(["plan", "--base", "p2", "--summary"], {
			env: { GITHUB_STEP_SUMMARY: file },
		});
		expect(stepped.stdout).toMatch(/^branch {2}main/);
		const printed = await run(["plan", "--base", "p2", "--summary"]);
		expect(readFileSync(file, "utf8")).toBe(printed.stdout);
		expect(printed.stdout).toContain(
			"| Unit | Kind | From | Bump | Next | Version |",
		);
		expect(printed.stdout).toContain(
			"| ui | prerelease | 1.0.0 | minor | 1.1.0 | 1.1.0-beta.3 |",
		);

		const usage = await run(["plan", "--json", "--summary"]);
		expect(usage.code).toBe(2);
	});

	it("rejects --json with --format", async () => {
		const result = await run(["plan", "--json", "--format", "json"]);
		expect(result.code).toBe(2);
	});
});

describe("explain", () => {
	it("explains files, changes, absorption and propagation (G31)", async () => {
		const ui = await run(["explain", "ui", "--base", "p0"]);
		expect(ui).toEqual({
			code: 0,
			stdout: [
				"ui  libs/ui  config  semver",
				"base    p0 (--base p0)",
				"",
				"affected  direct",
				"  libs/ui/a.ts",
				"release   1.0.0 -> 1.1.0 (minor), version 1.1.0-beta.3",
				"  base tag ui-v1.0.0",
				"",
				"changes (2)",
				"  p3  feat  ui button",
				"      libs/ui/a.ts",
				"  p2  feat  db query   via db",
				"      libs/db/a.ts",
				"",
			].join("\n"),
			stderr: "",
		});

		const web = await run(["explain", "web", "--base", "p0"]);
		expect(web.stdout).toContain(
			"affected  dependent via ui\nrelease   1.0.0 -> 1.0.1 (patch), version 1.0.1-beta.3\n",
		);
		expect(web.stdout).toContain("propagated from\n  ui (pinned)\n");

		const db = await run(["explain", "db", "--base", "p3"]);
		expect(db.stdout).toContain("affected  no\nrelease   not released\n");

		const footers = await runCli(
			["explain", "a", "--base", "c0"],
			memoryRepo({
				commits: [
					{
						id: "c0",
						files: {
							"tallyrelease.yaml": "units:\n  a: { release: true }\n",
							"a/x": "0",
						},
					},
					{
						id: "c1",
						message: "fix: x\n\nRelease-As: 2.0.0",
						files: { "a/x": "1" },
					},
					{
						id: "c2",
						message: "fix: y\n\nRelease-As: 0.5.0",
						files: { "a/x": "2" },
					},
				],
				tags: [{ name: "a-v1.0.0", commit: "c0" }],
			}),
		);
		expect(footers.stdout).toContain(
			"release-as footers\n  c2  0.5.0  ignored\n  c1  2.0.0  applied\n",
		);
		expect(footers.stderr).toContain(
			'warning[W_RELEASE_AS_INVALID]: unit "a": Release-As "0.5.0" in c2',
		);

		const groupedDag: Dag = {
			commits: [
				{
					id: "c0",
					files: {
						"tallyrelease.yaml": [
							"units:",
							"  a: { release: true }",
							"  b: { release: true }",
							"groups:",
							"  sdk: { units: [a, b] }",
						].join("\n"),
						"a/x": "0",
						"b/x": "0",
					},
				},
				{ id: "c1", message: "fix: a", files: { "a/x": "1" } },
			],
			tags: [
				{ name: "a-v1.0.0", commit: "c0" },
				{ name: "b-v1.0.0", commit: "c0" },
			],
		};
		const grouped = memoryRepo(groupedDag);
		const pulled = await runCli(["explain", "b", "--base", "c0"], grouped);
		expect(pulled.stdout).toContain(
			"affected  pulled by group sdk via a\ngroup     sdk (a, b)\nrelease   1.0.0 -> 1.0.1 (patch)\n",
		);
		const table = await runCli(["plan", "--base", "c0"], grouped);
		expect(table.stdout).toContain("UNIT  GROUP  KIND");

		const raised = await runCli(
			["explain", "b", "--base", "c0"],
			memoryRepo({
				...groupedDag,
				commits: [
					...groupedDag.commits,
					{
						id: "c2",
						message: "chore: a\n\nRelease-As: a@2.0.0",
						files: { "a/x": "2" },
					},
				],
			}),
		);
		expect(raised.stdout).toContain(
			"release   1.0.0 -> 2.0.0 (group sdk, release-as)\n",
		);

		const unknown = await run(["explain", "nope"]);
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toBe('error[E_UNIT_UNKNOWN]: unknown unit "nope"\n');
	});

	it("prints the introduction of a unit without a line base (G39)", async () => {
		const result = await runCli(
			["explain", "a", "--base", "c1"],
			memoryRepo({
				commits: [
					{
						id: "c0",
						files: {
							"tallyrelease.yaml": [
								"units:",
								"  a: { release: true }",
								"branches:",
								"  - { name: main, line: default, channel: beta }",
								"",
							].join("\n"),
						},
					},
					{ id: "c1", message: "feat: add a", files: { "a/x": "1" } },
					{ id: "c2", message: "fix: a", files: { "a/x": "2" } },
				],
			}),
		);
		expect(result.stdout).toContain(
			"release   first release -> 1.0.0 (minor), version 1.0.0-beta.2\n  introduced c1\n",
		);
	});
});

describe("plan --head", () => {
	const json = (value: unknown) => JSON.stringify(value);
	/** c1 adds unit y and releases every unit; c0 has only x. */
	const history: Dag = {
		commits: [
			{
				id: "c0",
				message: "feat: x",
				files: {
					"tallyrelease.yaml": "plugins:\n  node: {}\n",
					"package.json": json({ private: true, workspaces: ["packages/*"] }),
					"packages/x/package.json": json({ name: "x" }),
				},
			},
			{
				id: "c1",
				message: "feat: y",
				files: {
					"tallyrelease.yaml":
						"plugins:\n  node: {}\ndefaults: { release: true }\n",
					"packages/y/package.json": json({ name: "y" }),
				},
			},
		],
	};
	const expectHistorical = (stdout: string, head: string) => {
		const doc = planSchema.parse(JSON.parse(stdout));
		expect(doc.head).toBe(head);
		expect(doc.units.map((u) => [u.id, u.next])).toEqual([["x", "1.0.0"]]);
	};

	it("plans the tree at the sha with the current config (G35)", async () => {
		const result = await runCli(
			["plan", "--json", "--all", "--head", "c0"],
			memoryRepo(history),
		);
		expect(result.code).toBe(0);
		expectHistorical(result.stdout, "c0");
	});

	it("reads the commit from git without a worktree (G35)", async () => {
		const { dir, sha } = createRepo(history);
		const result = await runCli(
			["plan", "--json", "--all", "--head", sha("c0")],
			{ cwd: dir },
		);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("warning[W_HEAD_BRANCH]: ");
		expectHistorical(result.stdout, sha("c0"));
		expect(git(dir, "worktree", "list").split("\n")).toHaveLength(1);
		expect(existsSync(join(dir, ".git", "worktrees"))).toBe(false);

		const atHead = gitTreeFs(dir, sha("c1"));
		const disk = nodeFs(dir);
		for (const fs of [atHead, disk]) {
			expect(fs.glob(["**/package.json"])).toEqual([
				"package.json",
				"packages/x/package.json",
				"packages/y/package.json",
			]);
			expect(fs.glob(["packages/*"], { dirs: true })).toEqual([
				"packages/x",
				"packages/y",
			]);
			expect(fs.exists("packages")).toBe(true);
			expect(fs.read("packages/x/package.json")).toBe(json({ name: "x" }));
			expect(fs.read("missing")).toBeUndefined();
		}
	});
});

describe("plan on a maintenance branch", () => {
	/** release/1.x cut from web-v1.0.0 after main released web 2.0.0. */
	const maintenance = (fix: string): Dag => ({
		commits: [
			{
				id: "c0",
				files: {
					"tallyrelease.yaml": [
						"units:",
						"  apps/web: { id: web, release: true }",
						"  apps/api: { id: api, release: true }",
						"branches:",
						"  - { name: main, line: default }",
						"  - { name: 'release/{major}.x', line: maintenance, channel: 'rc-{major}', unit: web }",
					].join("\n"),
					"apps/web/a.ts": "0",
					"apps/api/a.ts": "0",
				},
			},
			{ id: "c1", message: "feat!: web v2", files: { "apps/web/a.ts": "1" } },
			{
				id: "c2",
				parents: ["c0"],
				message: "fix: api",
				files: { "apps/api/a.ts": "2" },
			},
			{ id: "c3", message: fix, files: { "apps/web/a.ts": "3" } },
		],
		tags: [
			{ name: "web-v1.0.0", commit: "c0" },
			{ name: "api-v5.3.0", commit: "c0" },
			{ name: "web-v2.0.0", commit: "c1" },
		],
	});

	it("applies the relative limit on a branch cut from a tag (G22)", async () => {
		const args = ["plan", "--base", "c0", "--branch", "release/1.x"];
		const ok = await runCli(args, memoryRepo(maintenance("feat: web")));
		expect(ok).toMatchObject({ code: 0, stderr: "" });
		expect(ok.stdout).toContain(
			"branch  release/1.x (rule release/{major}.x, maintenance line, channel rc-1, max bump minor, base 1.x of web)",
		);
		expect(ok.stdout).toContain(
			"api   prerelease  5.3.0  patch  5.3.1  5.3.1-rc-1.2",
		);
		expect(ok.stdout).toContain(
			"web   prerelease  1.0.0  minor  1.1.0  1.1.0-rc-1.2",
		);

		const capped = await runCli(args, memoryRepo(maintenance("feat!: web v2")));
		expect(capped).toMatchObject({ code: 1, stdout: "" });
		expect(capped.stderr).toBe(
			'error[E_CAP]: unit "web": 1.0.0 to 2.0.0 exceeds the minor limit of branch rule "release/{major}.x"; commits: c3 web v2 (major)\n',
		);
	});
});

describe("plan with the dart plugin", () => {
	const flutterApp = (buildOffset: number, tagged: string): Dag => ({
		commits: [
			{
				id: "f0",
				files: {
					"tallyrelease.yaml": `plugins: { dart: { buildOffset: ${String(buildOffset)} } }
defaults: { release: true, tagFormat: "v{version}" }
branches:
  - { name: main, line: default }
`,
					"pubspec.yaml":
						"name: app\npublish_to: none\nversion: 1.2.0+5\ndependencies:\n  flutter:\n    sdk: flutter\n",
				},
			},
			{ id: "f1", message: "fix: crash", files: { "lib/main.dart": "1" } },
		],
		tags: [{ name: `v${tagged}`, commit: "f0" }],
	});

	it.each([
		["the first-parent total plus buildOffset", 100, "1.2.0+5", "1.2.1+102"],
		["the highest tagged build plus one", 100, "1.2.0+500", "1.2.1+501"],
	])(
		"releases a flutter app with %s as build number",
		async (_, buildOffset, tagged, next) => {
			const result = await runCli(["plan", "--json", "--base", "f0"], {
				...memoryRepo(flutterApp(buildOffset, tagged)),
			});
			expect(result).toMatchObject({ code: 0, stderr: "" });
			expect(planSchema.parse(JSON.parse(result.stdout)).units).toMatchObject([
				{ scheme: "flutter", from: tagged, bump: "patch", next },
			]);
		},
	);
});
