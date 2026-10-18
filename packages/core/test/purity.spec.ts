import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

const run = (entry: string) =>
	promisify(execFile)("node", ["../../tools/check-purity.mjs", entry], {
		cwd: root,
	});

describe("check-purity", () => {
	it("accepts the public entry", async () => {
		await expect(run("src/index.ts")).resolves.toBeDefined();
	});

	it("rejects a node builtin import", async () => {
		await expect(run("test/purity/violation.ts")).rejects.toMatchObject({
			code: 1,
		});
	});
});
