import { TallyError } from "@tallyrelease/core";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { git, removeTmpDirs, tmpDir } from "./harness/git-repo.js";
import { gitBlob, gitTreeFs } from "../../src/fs-ctx.js";

afterAll(removeTmpDirs);

const makeRepo = () => {
	const dir = tmpDir();
	git(dir, "init", "-q");
	writeFileSync(join(dir, "a.txt"), "hello\n");
	git(dir, "add", ".");
	git(
		dir,
		"-c",
		"user.name=T",
		"-c",
		"user.email=t@example.com",
		"commit",
		"-q",
		"-m",
		"init",
	);

	return { dir, sha: git(dir, "rev-parse", "HEAD") };
};

const readError = (fn: () => unknown) => {
	try {
		fn();
	} catch (error) {
		return error;
	}

	return undefined;
};

describe("git blob reads", () => {
	it("returns undefined for an absent path and content for a present one", () => {
		const { dir, sha } = makeRepo();

		expect(gitBlob(dir)(sha, "a.txt")).toBe("hello\n");
		expect(gitBlob(dir)(sha, "missing.txt")).toBeUndefined();
	});

	it("throws E_GIT_READ for an unresolvable ref", () => {
		const { dir } = makeRepo();

		expect(readError(() => gitBlob(dir)("nope", "a.txt"))).toMatchObject({
			code: "E_GIT_READ",
		});
	});

	it("throws E_GIT_READ when the blob is unreadable", () => {
		const { dir, sha } = makeRepo();
		const fs = gitTreeFs(dir, sha);
		const oid = git(dir, "rev-parse", `${sha}:a.txt`);
		const objects = join(dir, ".git", "objects", oid.slice(0, 2));
		mkdirSync(objects, { recursive: true });
		rmSync(join(objects, oid.slice(2)));

		for (const read of [
			() => gitBlob(dir)(sha, "a.txt"),
			() => fs.read("a.txt"),
		]) {
			const error = readError(read);

			expect(error).toBeInstanceOf(TallyError);
			expect(error).toMatchObject({
				code: "E_GIT_READ",
				details: { ref: sha, path: "a.txt" },
			});
		}
	});
});
