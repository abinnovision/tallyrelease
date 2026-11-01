import { describe, expect, it } from "vitest";

import { conventionalCommits, parseCommit } from "./conventional.js";
import { memoryCtx } from "./testing/index.js";

import type { RawCommit } from "./plugin.js";

const commit = (sha: string, message: string): RawCommit => ({
	sha,
	parents: [],
	message,
	files: [],
	date: "2024-01-01T00:00:00Z",
});

describe("parseCommit", () => {
	it("parses header forms", () => {
		expect(parseCommit("feat: add x")).toMatchObject({
			type: "feat",
			scope: undefined,
			breaking: false,
			subject: "add x",
		});
		expect(parseCommit("fix(core): y")).toMatchObject({
			type: "fix",
			scope: "core",
			subject: "y",
		});
		expect(parseCommit("feat(api)!: drop v1")).toMatchObject({
			type: "feat",
			scope: "api",
			breaking: true,
		});
		expect(parseCommit("refactor!: z").breaking).toBe(true);
	});

	it("keeps a non-conventional header as subject", () => {
		expect(parseCommit("  Update README (#4)  ")).toMatchObject({
			type: "",
			subject: "Update README",
			pr: 4,
		});
	});

	it("treats an empty scope as no scope", () => {
		expect(parseCommit("feat(): a")).toMatchObject({
			type: "feat",
			scope: undefined,
			subject: "a",
		});
	});

	it("takes the PR number only from the end of the subject", () => {
		expect(parseCommit("fix: a (#123)")).toMatchObject({
			subject: "a",
			pr: 123,
		});
		expect(parseCommit("fix: see (#12) later")).toMatchObject({
			subject: "see (#12) later",
			pr: undefined,
		});
	});

	it("sets breaking from both uppercase footer spellings", () => {
		const space = parseCommit("feat: a\n\nBREAKING CHANGE: gone");
		const dash = parseCommit("feat: a\n\nBREAKING-CHANGE: gone");
		expect(space.breaking).toBe(true);
		expect(space.footers).toEqual({ "breaking change": ["gone"] });
		expect(dash.breaking).toBe(true);
		expect(dash.footers).toEqual({ "breaking-change": ["gone"] });
		expect(parseCommit("feat: a\n\nbreaking-change: gone").breaking).toBe(
			false,
		);
	});

	it("starts footers at the first footer paragraph of a squash message", () => {
		const parsed = parseCommit(
			"feat: x (#12)\n\n* feat: x\n\n* fix: y\n\nBREAKING CHANGE: api gone\n\n---------\n\nCo-authored-by: A <a@x>",
		);
		expect(parsed).toMatchObject({
			subject: "x",
			pr: 12,
			breaking: true,
			body: "* feat: x\n\n* fix: y",
		});
		expect(parsed.footers).toEqual({
			"breaking change": ["api gone\n\n---------"],
			"co-authored-by": ["A <a@x>"],
		});
	});

	it("keeps a trailing paragraph in the footer value", () => {
		const parsed = parseCommit(
			"feat: x\n\nBREAKING CHANGE: api gone\n\nMigrate by doing y.",
		);
		expect(parsed.breaking).toBe(true);
		expect(parsed.footers).toEqual({
			"breaking change": ["api gone\n\nMigrate by doing y."],
		});
	});

	it("keeps body indentation and generic footers with case-insensitive keys", () => {
		const parsed = parseCommit(
			"fix: a\n\n\n  indented\nparagraph\n\nsecond\n\nRefs #1\nreviewed-by: A\nReviewed-By: B\n  continued",
		);
		expect(parsed.body).toBe("  indented\nparagraph\n\nsecond");
		expect(parsed.footers).toEqual({
			refs: ["1"],
			"reviewed-by": ["A", "B\n  continued"],
		});
	});

	it("tolerates CRLF and trailing newlines", () => {
		expect(
			parseCommit(
				"feat(x): a (#7)\r\n\r\nbody\r\n\r\nRelease-As: 2.0.0\r\n\r\n",
			),
		).toEqual({
			type: "feat",
			scope: "x",
			breaking: false,
			subject: "a",
			body: "body",
			pr: 7,
			footers: { "release-as": ["2.0.0"] },
		});
	});
});

describe("conventionalCommits", () => {
	const collect = (commits: RawCommit[]) =>
		conventionalCommits.collect(memoryCtx(), {
			from: null,
			to: "b",
			commits,
			units: [],
		});

	it("maps each commit to exactly one Change", async () => {
		expect(
			await collect([
				commit("a", "feat(ui)!: x (#3)\n\nwhy"),
				commit("b", "chore: y"),
				commit("c", "WIP"),
			]),
		).toEqual([
			{
				sha: "a",
				type: "feat",
				breaking: true,
				scope: "ui",
				subject: "x",
				body: "why",
				pr: 3,
			},
			{ sha: "b", type: "chore", breaking: false, subject: "y" },
			{ sha: "c", type: "", breaking: false, subject: "WIP" },
		]);
	});

	it("uses the first line of a Release-As value", async () => {
		const [change] = await collect([
			commit("a", "fix: x\n\nRelease-As: 2.0.0\nsee above"),
		]);
		expect(change?.releaseAs).toEqual([{ version: "2.0.0" }]);
	});

	it("collects plain and qualified Release-As values", async () => {
		const [change, ...rest] = await collect([
			commit(
				"a",
				"feat: x\n\nRelease-As: 3.0.0\nrelease-as: core@1.0.0\nRELEASE-AS: cli@2.0.0-beta.1",
			),
		]);
		expect(rest).toEqual([]);
		expect(change?.releaseAs).toEqual([
			{ version: "3.0.0" },
			{ unit: "core", version: "1.0.0" },
			{ unit: "cli", version: "2.0.0-beta.1" },
		]);
	});
});
