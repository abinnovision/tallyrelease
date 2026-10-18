import { TallyError } from "@tallyrelease/core";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch/posix.js";
import { globSync } from "tinyglobby";

import { gitEnv } from "./git/exec.js";

import type { Env } from "./ci/github-env.js";
import type { ReadonlyFs } from "@tallyrelease/core";

const IGNORED = ["**/.git/**", "**/node_modules/**", "vendor/**"];

const readError = (error: unknown, ref: string, path: string) => {
	const stderr = (error as { stderr?: Buffer }).stderr?.toString("utf8");
	const reason = stderr?.match(/^.+$/m)?.[0] ?? String(error);

	return new TallyError(
		"E_GIT_READ",
		`cannot read "${path}" at ${ref}: ${reason}`,
		{ ref, path },
	);
};

/** Content of the blob `ref:path`; any git failure is `E_GIT_READ`. */
const catBlob =
	(root: string, env: Env) =>
	(ref: string, path: string): string => {
		try {
			return execFileSync("git", ["cat-file", "blob", `${ref}:${path}`], {
				cwd: root,
				env: gitEnv(env),
				maxBuffer: 256 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			}).toString("utf8");
		} catch (error) {
			throw readError(error, ref, path);
		}
	};

/** `ReadonlyFs` over the directory `root`. */
export const nodeFs = (root: string): ReadonlyFs => ({
	read: (path) => {
		try {
			return readFileSync(join(root, path), "utf8");
		} catch {
			return undefined;
		}
	},
	exists: (path) => existsSync(join(root, path)),
	glob: (patterns, opts) =>
		globSync(patterns, {
			cwd: root,
			dot: true,
			ignore: IGNORED,
			expandDirectories: false,
			onlyDirectories: opts?.dirs ?? false,
		})
			.map((p) => p.replace(/\/$/, ""))
			.sort(),
});

/**
 * `ReadonlyFs` over the tree of commit `sha` in the repository at `root`,
 * matching `nodeFs`; paths are listed once, files read lazily.
 */
export const gitTreeFs = (
	root: string,
	sha: string,
	env: Env = process.env,
): ReadonlyFs => {
	const git = (args: string[]) =>
		execFileSync("git", ["-c", "core.quotePath=false", ...args], {
			cwd: root,
			env: gitEnv(env),
			maxBuffer: 256 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
	const blob = catBlob(root, env);
	const ignored = picomatch(IGNORED, { dot: true });
	const paths = git(["ls-tree", "-r", "-z", "--name-only", sha])
		.toString("utf8")
		.split("\0")
		.filter((p) => p !== "" && !ignored(p))
		.sort();
	const files = new Set(paths);
	const dirs = [
		...new Set(
			paths.flatMap((p) => {
				const parts = p.split("/");

				return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
			}),
		),
	]
		.filter((d) => !ignored(d) && !ignored(`${d}/`))
		.sort();
	const dirSet = new Set(dirs);
	const cache = new Map<string, string | undefined>();

	return {
		read: (path) => {
			if (!files.has(path)) {
				return undefined;
			}

			if (!cache.has(path)) {
				cache.set(path, blob(sha, path));
			}

			return cache.get(path);
		},
		exists: (path) => path === "." || files.has(path) || dirSet.has(path),
		glob: (patterns, opts) => {
			const match = picomatch([...patterns], { dot: true });

			return (opts?.dirs ? dirs : paths).filter((p) => match(p));
		},
	};
};

/**
 * Reader of `path` at commit `ref` in the repository at `root`: the content,
 * undefined when absent. Any other git failure throws `E_GIT_READ`.
 */
export const gitBlob = (root: string, env: Env = process.env) => {
	const blob = catBlob(root, env);

	return (ref: string, path: string): string | undefined => {
		let listing: string;

		try {
			listing = execFileSync("git", ["ls-tree", "-z", ref, "--", path], {
				cwd: root,
				env: gitEnv(env),
				stdio: ["ignore", "pipe", "pipe"],
			}).toString("utf8");
		} catch (error) {
			throw readError(error, ref, path);
		}

		return listing === "" ? undefined : blob(ref, path);
	};
};
