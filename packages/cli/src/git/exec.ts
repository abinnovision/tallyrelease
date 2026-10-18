import { execFile } from "node:child_process";

import type { Env } from "../ci/github-env.js";

// Set by a surrounding git hook; they would point git at another repository.
const REPO_VARS = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]);

export interface GitOptions {
	debug?: ((message: string) => void) | undefined;
	/** Environment of the subprocess; defaults to `process.env`. */
	env?: Env | undefined;
	/** Set over `env`. */
	vars?: Readonly<Record<string, string>>;
}

/** `env` without `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE`, plus `vars`. */
export const gitEnv = (
	env: Env,
	vars: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> => ({
	...Object.fromEntries(
		Object.entries(env).filter(([key]) => !REPO_VARS.has(key)),
	),
	...vars,
});

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs `git` in `cwd`; resolves with the exit code instead of rejecting. */
export const git = (
	cwd: string,
	args: readonly string[],
	{ debug, env, vars }: GitOptions = {},
): Promise<GitResult> => {
	debug?.(`git ${args.join(" ")}`);

	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["-c", "core.quotePath=false", ...args],
			{
				cwd,
				encoding: "utf8",
				maxBuffer: 256 * 1024 * 1024,
				env: gitEnv(env ?? process.env, vars),
			},
			(error, stdout, stderr) => {
				if (error === null) {
					resolve({ code: 0, stdout, stderr });
				} else if (typeof error.code === "number") {
					resolve({ code: error.code, stdout, stderr });
				} else {
					reject(new Error(error.message, { cause: error }));
				}
			},
		);
	});
};

/** Runs `git` and returns stdout; throws on a non-zero exit code. */
export const gitOk = async (
	cwd: string,
	args: readonly string[],
	opts?: GitOptions,
): Promise<string> => {
	const result = await git(cwd, args, opts);
	if (result.code !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed (${String(result.code)}): ${result.stderr.trim()}`,
		);
	}

	return result.stdout;
};
