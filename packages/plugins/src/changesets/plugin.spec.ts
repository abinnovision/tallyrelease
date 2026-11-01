import { memoryCtx } from "@tallyrelease/core/testing";
import { describe, expect, it } from "vitest";

import { changesetsPlugin } from "./plugin.js";

import type { Unit } from "@tallyrelease/core";

const unit = (id: string, packageName: string): Unit => ({
	id,
	root: `packages/${id}`,
	plugin: "node",
	include: [],
	exclude: [],
	version: "file",
	scheme: "semver",
	tagFormat: "",
	propagate: "auto",
	tags: [],
	initialVersion: null,
	meta: { node: { packageName } },
});

const units = [unit("core", "@s/core"), unit("cli", "@s/cli")];

const collect = async (files: Record<string, string>, touched: string[]) => {
	const ctx = memoryCtx({ files });
	const changes = await changesetsPlugin.intent?.[0]?.collect(ctx, {
		from: null,
		to: "c1",
		commits: [
			{ sha: "c1", parents: [], message: "chore", files: touched, date: "" },
		],
		units,
	});

	return { changes, warnings: ctx.warnings };
};

describe("changesets plugin", () => {
	it("maps a changeset to one change per bump level", async () => {
		const { changes } = await collect(
			{
				".changeset/a.md": [
					"---",
					'"@s/core": major',
					"cli: minor",
					"---",
					"",
					"Add an api",
					"",
					"With details.",
				].join("\n"),
			},
			[".changeset/a.md"],
		);
		expect(changes).toEqual([
			{
				type: "feat",
				breaking: true,
				units: ["core"],
				subject: "Add an api",
				body: "With details.",
				files: [".changeset/a.md"],
			},
			{
				type: "feat",
				breaking: false,
				units: ["cli"],
				subject: "Add an api",
				body: "With details.",
				files: [".changeset/a.md"],
			},
		]);
	});

	it("reads only changesets touched in the range", async () => {
		const { changes, warnings } = await collect(
			{
				".changeset/README.md": "# Changesets\n",
				".changeset/old.md": "---\ncore: patch\n---\n\nOld\n",
				".changeset/new.md":
					"\uFEFF--- \r\ncore: patch\n'@s/core': patch\ncli: none\nx: huge\n---\r\n\r\nNew\r\n",
				".changeset/plain.md": "No frontmatter\n",
			},
			[".changeset/README.md", ".changeset/new.md", ".changeset/plain.md"],
		);
		expect(changes).toEqual([
			{
				type: "fix",
				breaking: false,
				units: ["core"],
				subject: "New",
				files: [".changeset/new.md"],
			},
		]);
		expect(warnings).toEqual([
			'.changeset/new.md: "x" has unknown bump "huge"',
			".changeset/plain.md has no frontmatter",
		]);
	});
});
