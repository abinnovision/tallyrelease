import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { memoryRepo } from "./harness/memory-repo.js";
import { runCli } from "./harness/run-cli.js";
import { explainSchema } from "../../src/explain-schema.js";

import type { Dag } from "@tallyrelease/core/testing";

/** ui is released at c0 and absorbs db. */
const dag: Dag = {
	commits: [
		{
			id: "c0",
			files: {
				"tallyrelease.yaml": [
					"units:",
					"  libs/db: { id: db }",
					"  libs/ui: { id: ui, release: true }",
					"deps:",
					"  - { from: db, to: ui }",
					"branches:",
					"  - { name: main, line: default }",
				].join("\n"),
				"libs/db/a.ts": "0",
				"libs/ui/a.ts": "0",
			},
		},
		{ id: "c1", message: "feat: db query", files: { "libs/db/a.ts": "1" } },
		{ id: "c2", message: "fix: ui button", files: { "libs/ui/a.ts": "2" } },
	],
	tags: [{ name: "ui-v1.0.0", commit: "c0" }],
};

const run = async (args: string[]) =>
	await runCli(["explain", "ui", "--base", "c0", ...args], memoryRepo(dag));

describe("explain --json", () => {
	it("prints a document valid against explain.schema.json", async () => {
		const result = await run(["--json"]);
		expect(result).toMatchObject({ code: 0, stderr: "" });

		const doc: unknown = JSON.parse(result.stdout);
		const validate = new Ajv2020({ strict: false }).compile(
			z.toJSONSchema(explainSchema),
		);
		expect(validate(doc)).toBe(true);
		expect(explainSchema.parse(doc)).toMatchObject({
			schema: 1,
			unit: { id: "ui", from: "1.0.0", next: "1.0.1" },
			nextSource: "bump",
			files: ["libs/ui/a.ts"],
			changes: [
				{ sha: "c2", subject: "ui button", files: ["libs/ui/a.ts"] },
				{ sha: "c1", via: "db", files: ["libs/db/a.ts"] },
			],
		});

		expect((await run(["--format", "json"])).stdout).toBe(result.stdout);
	});

	it("prints a null unit when the unit is neither affected nor pending", async () => {
		const result = await runCli(
			["explain", "db", "--base", "c2", "--json"],
			memoryRepo(dag),
		);
		expect(explainSchema.parse(JSON.parse(result.stdout))).toMatchObject({
			unit: null,
			nextSource: null,
			files: [],
			changes: [],
		});
	});

	it("rejects --json with --format", async () => {
		expect((await run(["--json", "--format", "json"])).code).toBe(2);
	});
});
