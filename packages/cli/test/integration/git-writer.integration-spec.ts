import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createRepo, git, removeTmpDirs, tmpDir } from "./harness/git-repo.js";
import { gitReader } from "../../src/git/reader.js";
import { gitWriter } from "../../src/git/writer.js";

afterAll(removeTmpDirs);

const BRANCH = "refs/heads/tallyrelease/release/main/shared";

/** Repo with `main` pushed to a bare `origin`; signing would fail if attempted. */
const setup = () => {
	const { dir } = createRepo({
		commits: [
			{ id: "c0", files: { "a.txt": "a\n", "pkg/package.json": "{}\n" } },
			{ id: "c1", files: { "a.txt": "b\n" } },
		],
	});
	writeFileSync(join(dir, "bin.sh"), "#!/bin/sh\n");
	git(dir, "add", "--chmod=+x", "bin.sh");
	git(
		dir,
		"-c",
		"user.name=T",
		"-c",
		"user.email=t@example.com",
		"commit",
		"-qm",
		"exec",
	);
	const origin = tmpDir("origin.git");
	git(origin, "init", "--quiet", "--bare");
	git(dir, "remote", "add", "origin", origin);
	git(dir, "push", "--quiet", "origin", "main");
	git(dir, "config", "commit.gpgsign", "true");
	git(dir, "config", "tag.gpgsign", "true");
	git(dir, "config", "gpg.program", "false");

	const head = git(dir, "rev-parse", "HEAD");
	const date = git(dir, "log", "-1", "--format=%cI");
	const remote = (ref: string) =>
		git(origin, "for-each-ref", "--format=%(objectname)", ref);

	return { dir, head, date, remote, writer: gitWriter(dir) };
};

describe("git writer (E30)", () => {
	it("commits deterministically without touching the checkout", async () => {
		const { dir, head, date, writer } = setup();
		const files = new Map([
			["pkg/package.json", '{ "version": "1.0.0" }\n'],
			["pkg/CHANGELOG.md", "# Changelog\n"],
			["bin.sh", "#!/bin/sh\necho 1\n"],
		]);
		const status = git(dir, "status", "--porcelain");
		const index = git(dir, "ls-files", "--stage");

		const commit = { parent: head, files, message: "chore(release): x", date };
		expect(await gitReader(dir).commitDate("HEAD")).toBe(date);
		const sha = await writer.commitFiles(commit);
		expect(await writer.commitFiles(commit)).toBe(sha);
		expect(git(dir, "status", "--porcelain")).toBe(status);
		expect(git(dir, "ls-files", "--stage")).toBe(index);
		expect(git(dir, "rev-parse", "HEAD")).toBe(head);

		expect(git(dir, "show", `${sha}:pkg/package.json`)).toBe(
			'{ "version": "1.0.0" }',
		);
		expect(git(dir, "show", `${sha}:a.txt`)).toBe("b");
		expect(
			git(dir, "ls-tree", sha, "bin.sh", "pkg/CHANGELOG.md").replace(
				/\s\w+\t/g,
				" ",
			),
		).toBe("100755 blob bin.sh\n100644 blob pkg/CHANGELOG.md");
		expect(
			git(dir, "log", "-1", "--format=%P|%an <%ae>|%cn <%ce>|%aI|%cI", sha),
		).toBe(
			`${head}|tallyrelease <tallyrelease@users.noreply.github.com>|tallyrelease <tallyrelease@users.noreply.github.com>|${date}|${date}`,
		);
		expect(git(dir, "cat-file", "commit", sha)).not.toContain("gpgsig");
	});

	it("commits as a custom identity deterministically", async () => {
		const { dir, head, date } = setup();
		const identity = {
			author: {
				name: "bot[bot]",
				email: "1+bot[bot]@users.noreply.github.com",
			},
			committer: { name: "Committer", email: "c@example.com" },
		};
		const writer = gitWriter(dir, undefined, { identity });
		const commit = {
			parent: head,
			files: new Map([["a.txt", "x\n"]]),
			message: "chore(release): x",
			date,
		};
		const sha = await writer.commitFiles(commit);

		expect(await writer.commitFiles(commit)).toBe(sha);
		expect(git(dir, "log", "-1", "--format=%an <%ae>|%cn <%ce>", sha)).toBe(
			"bot[bot] <1+bot[bot]@users.noreply.github.com>|Committer <c@example.com>",
		);
	});

	it("pushes with leases, atomic tags and forced floating tags", async () => {
		const { dir, head, date, remote, writer } = setup();
		const commit = async (content: string) =>
			await writer.commitFiles({
				parent: head,
				files: new Map([["a.txt", content]]),
				message: "chore(release): x",
				date,
			});
		const first = await commit("1\n");
		const second = await commit("2\n");

		// First push: the branch must not exist yet.
		await writer.push([`${first}:${BRANCH}`], { leases: { [BRANCH]: "" } });
		expect(remote(BRANCH)).toBe(first);
		await expect(
			writer.push([`${second}:${BRANCH}`], { leases: { [BRANCH]: "" } }),
		).rejects.toMatchObject({ code: "E_PUSH_LEASE" });
		await expect(
			writer.push([`${second}:${BRANCH}`], { leases: { [BRANCH]: head } }),
		).rejects.toMatchObject({ code: "E_PUSH_LEASE" });
		await writer.push([`${second}:${BRANCH}`], { leases: { [BRANCH]: first } });
		expect(remote(BRANCH)).toBe(second);

		// Tags: no-op at the same sha, E_TAG_EXISTS elsewhere, forced move.
		await writer.tag("x-v1.0.0", head);
		await writer.tag("x-v1.0.0", head);
		await writer.tag("x-v1", head);
		await expect(writer.tag("x-v1.0.0", first)).rejects.toMatchObject({
			code: "E_TAG_EXISTS",
		});
		expect(git(dir, "cat-file", "-t", "x-v1.0.0")).toBe("commit");

		// Atomic: a stale lease keeps the tags off the remote too.
		await expect(
			writer.push([`${first}:${BRANCH}`, "refs/tags/x-v1.0.0"], {
				atomic: true,
				leases: { [BRANCH]: first },
			}),
		).rejects.toMatchObject({ code: "E_PUSH_LEASE" });
		expect(remote("refs/tags/x-v1.0.0")).toBe("");
		await writer.push(["refs/tags/x-v1.0.0", "refs/tags/x-v1"], {
			atomic: true,
		});
		expect(remote("refs/tags/x-v1.0.0")).toBe(head);

		// A remote tag elsewhere is not overwritten without force.
		await writer.tag("x-v1.0.0", first, { force: true });
		await expect(writer.push(["refs/tags/x-v1.0.0"])).rejects.toMatchObject({
			code: "E_TAG_EXISTS",
		});
		expect(remote("refs/tags/x-v1.0.0")).toBe(head);

		await writer.tag("x-v1", first, { force: true });
		await writer.push(["+refs/tags/x-v1"]);
		expect(remote("refs/tags/x-v1")).toBe(first);

		// Deleting a branch.
		await writer.push([`:${BRANCH}`]);
		expect(remote(BRANCH)).toBe("");
	});

	it("sends the token as the only auth header", async () => {
		const { dir, writer } = setup();
		const auth: string[][] = [];
		const server = createServer((req, res) => {
			auth.push(
				req.rawHeaders.filter(
					(_, i, all) => all[i - 1]?.toLowerCase() === "authorization",
				),
			);
			res.writeHead(403).end();
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		const host = `http://127.0.0.1:${String(typeof address === "object" ? address?.port : "")}`;
		git(dir, "remote", "set-url", "origin", `${host}/acme/repo.git`);
		// Persisted checkout credentials for the same host.
		git(dir, "config", `http.${host}/.extraheader`, "AUTHORIZATION: basic old");

		try {
			await expect(
				writer.push(["refs/heads/main"], { token: "tok" }),
			).rejects.toThrow(/git push failed/);
		} finally {
			server.close();
		}

		const expected = `basic ${Buffer.from("x-access-token:tok").toString("base64")}`;
		expect(auth[0]).toEqual([expected]);
	});
});
