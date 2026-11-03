import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createRepo, removeTmpDirs, tmpDir } from "./harness/git-repo.js";

const script = new URL("../../scripts/generate-version.mjs", import.meta.url);

const bake = async (dir: string) => {
	mkdirSync(join(dir, "dist"));
	execFileSync("node", [fileURLToPath(script)], { cwd: dir });

	return {
		...((await import(
			pathToFileURL(join(dir, "dist/version.js")).href
		)) as object),
	};
};

afterEach(removeTmpDirs);

describe("generate-version", () => {
	it("bakes the package version and HEAD commit", async () => {
		const { dir, sha } = createRepo({
			commits: [{ id: "c0", files: { "package.json": '{"version":"1.2.3"}' } }],
		});

		expect(await bake(dir)).toEqual({ version: "1.2.3", commit: sha("c0") });
	});

	it("bakes a null commit outside a repository", async () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "package.json"), '{"version":"1.2.3"}');

		expect(await bake(dir)).toEqual({ version: "1.2.3", commit: null });
	});
});
