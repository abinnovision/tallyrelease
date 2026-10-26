import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { renderChangelogSection, updateChangelog } from "./changelog.js";
import { conventionalCommits, parseCommit } from "./conventional.js";
import { encodeMarker } from "./marker.js";
import { semver } from "./semver.js";
import { memoryCtx } from "./testing/index.js";
import { history } from "../test/fixtures/release-please-history.js";

import type { ChangelogInput } from "./changelog.js";
import type { PlanChange } from "./model/plan-types.js";
import type { Change } from "./plugin.js";

// Repository URL in the release-please written CHANGELOG sections.
const REPO = "https://github.com/abinnovision/tallyrelease";

/** The plan change of a commit, as the conventional-commits source yields it. */
const change = (sha: string, message: string): PlanChange => {
	const commits = [{ sha, parents: [], message, files: [], date: "" }];
	const [c] = conventionalCommits.collect(memoryCtx(), {
		from: null,
		to: sha,
		commits,
	}) as Change[];
	const { type, breaking, scope, subject, notes, pr } = c ?? {
		type: "",
		breaking: false,
		subject: "",
	};

	return {
		sha,
		type,
		breaking,
		...(scope === undefined ? {} : { scope }),
		subject,
		...(notes === undefined ? {} : { notes }),
		...(pr === undefined ? {} : { pr }),
	};
};

const input = (over: Partial<ChangelogInput>): ChangelogInput => ({
	version: "2.0.0",
	date: "2026-10-15",
	repoUrl: "https://github.com/o/r",
	baseTag: "a-v1.0.0",
	tag: "a-v2.0.0",
	changes: [],
	...over,
});

/** The section of `version` in a package's CHANGELOG.md. */
const section = (pkg: string, version: string): string => {
	const lines = readFileSync(
		join(import.meta.dirname, "../..", pkg, "CHANGELOG.md"),
		"utf8",
	).split("\n");
	const start = lines.findIndex(
		(l) => l.startsWith(`## [${version}]`) || l.startsWith(`## ${version} `),
	);
	const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));

	return lines
		.slice(start, end === -1 ? undefined : end)
		.join("\n")
		.trim();
};

describe("renderChangelogSection", () => {
	it.each([
		["cli", "0.2.0", "cli-v0.1.1"],
		["core", "0.2.0", "core-v0.1.1"],
		["cli", "0.1.1", "cli-v0.1.0"],
		["core", "0.1.1", "core-v0.1.0"],
		["cli", "0.1.0", null],
		["core", "0.1.0", null],
	])("matches release-please for %s %s (L01)", (unit, version, baseTag) => {
		const rendered = renderChangelogSection({
			version,
			date: "2026-10-15",
			repoUrl: REPO,
			baseTag,
			tag: `${unit}-v${version}`,
			changes: (history[`${unit}@${version}`] ?? []).map(([sha, msg]) =>
				change(sha, msg),
			),
			dependencies:
				unit === "cli"
					? [{ field: "dependencies", name: "@tallyrelease/core", version }]
					: [],
		});

		expect(rendered).toBe(section(unit, version));
	});

	it("renders a first release without a compare link (L02)", () => {
		expect(
			renderChangelogSection(
				input({
					version: "1.0.0",
					baseTag: null,
					changes: [
						change("b".repeat(40), "fix: two"),
						change("a".repeat(40), "feat: one"),
					],
				}),
			),
		).toBe(
			[
				"## 1.0.0 (2026-10-15)",
				"",
				"",
				"### Features",
				"",
				"* one ([aaaaaaa](https://github.com/o/r/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa))",
				"",
				"",
				"### Bug Fixes",
				"",
				"* two ([bbbbbbb](https://github.com/o/r/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb))",
			].join("\n"),
		);
	});

	it("lists breaking notes first and the change under its type (L03)", () => {
		// Expected text produced by release-please 17.2.1 for the same commits.
		expect(
			renderChangelogSection(
				input({
					changes: [
						change("c".repeat(40), "feat(api)!: drop v1 endpoints (#12)"),
						change(
							"b".repeat(40),
							"fix: handle empty input\n\nBREAKING CHANGE: empty input now throws\ninstead of returning null",
						),
						change("a".repeat(40), "feat: add thing"),
					],
				}),
			),
		).toBe(
			"## [2.0.0](https://github.com/o/r/compare/a-v1.0.0...a-v2.0.0) (2026-10-15)\n\n\n### ⚠ BREAKING CHANGES\n\n* **api:** drop v1 endpoints ([#12](https://github.com/o/r/issues/12))\n* empty input now throws instead of returning null\n\n### Features\n\n* add thing ([aaaaaaa](https://github.com/o/r/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa))\n* **api:** drop v1 endpoints ([#12](https://github.com/o/r/issues/12)) ([ccccccc](https://github.com/o/r/commit/cccccccccccccccccccccccccccccccccccccccc))\n\n\n### Bug Fixes\n\n* handle empty input ([bbbbbbb](https://github.com/o/r/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb))",
		);
	});

	it("renders breaking notes like release-please", () => {
		// Expected text produced by release-please 17.2.1 for the same commits.
		const changes = [
			change(
				"a".repeat(40),
				"feat: one\n\nBREAKING CHANGE: first line\nsecond line\n\nlater paragraph",
			),
			change(
				"b".repeat(40),
				"feat: two\n\nBREAKING CHANGE: alpha\nBREAKING CHANGE: beta",
			),
			change(
				"c".repeat(40),
				"feat: three\n\nBREAKING CHANGE: gone\n- item one\n- item two",
			),
		];
		const text = renderChangelogSection(input({ repoUrl: null, changes }));

		expect(text.split("\n\n### Features")[0]).toBe(
			"## 2.0.0 (2026-10-15)\n\n\n### ⚠ BREAKING CHANGES\n\n* first line second line\n* beta\n* gone\n    - item one\n    - item two",
		);
	});

	it("hides chore, docs, ci, refactor, test and build; no links without a repo URL (L09)", () => {
		const changes = ["chore", "docs", "ci", "refactor", "test", "build"].map(
			(type, i) => change(String(i).repeat(40), `${type}: hidden`),
		);
		changes.push(change("f".repeat(40), "fix(x): shown (#3)"));

		expect(renderChangelogSection(input({ repoUrl: null, changes }))).toBe(
			"## 2.0.0 (2026-10-15)\n\n\n### Bug Fixes\n\n* **x:** shown (#3)",
		);
	});

	it("takes the date as input only (L11)", () => {
		const changes = [change("a".repeat(40), "feat: one")];
		const [a, b] = ["2026-10-15", "2026-10-16"].map((date) =>
			renderChangelogSection(input({ date, changes })).split("\n"),
		);

		expect(a?.slice(1)).toEqual(b?.slice(1));
		expect([a?.[0], b?.[0]]).toEqual([
			"## [2.0.0](https://github.com/o/r/compare/a-v1.0.0...a-v2.0.0) (2026-10-15)",
			"## [2.0.0](https://github.com/o/r/compare/a-v1.0.0...a-v2.0.0) (2026-10-16)",
		]);
	});

	it("adds no footers to a squash commit carrying it (R78)", () => {
		const body = renderChangelogSection(
			input({
				changes: [
					change(
						"a".repeat(40),
						"feat!: drop x\n\nBREAKING CHANGE: x is gone\nRelease-As: 9.0.0",
					),
				],
			}),
		);
		const marker = encodeMarker({
			head: "h",
			releaseCommit: "r",
			releases: [],
		});
		const parsed = parseCommit(
			`chore(release): a@2.0.0\n\n${body}\n\n${marker}`,
		);

		expect(parsed).toMatchObject({
			type: "chore",
			breaking: false,
			footers: {},
		});
	});
});

describe("updateChangelog", () => {
	const fresh = renderChangelogSection(
		input({
			version: "0.3.2",
			baseTag: "a-v0.2.0",
			tag: "a-v0.3.2",
			repoUrl: null,
		}),
	);
	const old = [
		"## [0.2.0](https://x/compare/a-v0.1.1...a-v0.2.0) (2026-01-02)",
		"",
		"",
		"### Features",
		"",
		"* old",
		"",
		"### [0.1.1](https://x/compare/a-v0.1.0...a-v0.1.1) (2026-01-01)",
		"",
		"* patch",
		"",
		"## 0.1.0 (2025-12-31)",
		"",
		"* first",
		"",
	].join("\n");

	it("replaces untagged sections above the base version (L05)", () => {
		const content = [
			"# Changelog",
			"",
			"## [0.3.1](https://x/compare/a-v0.2.0...a-v0.3.1) (2026-02-02)",
			"",
			"* leftover",
			"",
			"### [0.3.0](https://x/compare/a-v0.2.0...a-v0.3.0) (2026-02-01)",
			"",
			"* leftover",
			"",
			old,
		].join("\n");

		expect(
			updateChangelog(content, fresh, { baseVersion: "0.2.0", scheme: semver }),
		).toBe(`# Changelog\n\n${fresh}\n\n${old}`);
	});

	it("creates a missing file (L06)", () => {
		expect(
			updateChangelog(undefined, fresh, {
				baseVersion: "0.2.0",
				scheme: semver,
			}),
		).toBe(`# Changelog\n\n${fresh}\n`);
	});

	it("recognises legacy headings and keeps the preamble (L10)", () => {
		const preamble = "# Changelog\n\nAll notable changes.\n### Notes\n";
		const content = `${preamble}\n${old}`;

		expect(
			updateChangelog(content, fresh, { baseVersion: "0.2.0", scheme: semver }),
		).toBe(
			`# Changelog\n\nAll notable changes.\n### Notes\n\n${fresh}\n\n${old}`,
		);
		expect(
			updateChangelog(content, fresh, { baseVersion: "0.1.0", scheme: semver }),
		).toBe(
			`# Changelog\n\nAll notable changes.\n### Notes\n\n${fresh}\n\n## 0.1.0 (2025-12-31)\n\n* first\n`,
		);
	});

	it("without a base version replaces only sections not below the new one", () => {
		const first = renderChangelogSection(
			input({ version: "1.0.0", baseTag: null, repoUrl: null }),
		);
		const content = `# Changelog\n\n## 1.0.0 (2026-01-01)\n\n* stale\n\n${old}`;

		expect(
			updateChangelog(content, first, { baseVersion: null, scheme: semver }),
		).toBe(`# Changelog\n\n${first}\n\n${old}`);
	});
});
