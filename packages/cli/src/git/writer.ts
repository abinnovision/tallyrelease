import { TallyError } from "@tallyrelease/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitOk, git as run } from "./exec.js";

import type { Env } from "../ci/github-env.js";

export interface Ident {
	name: string;
	email: string;
}

/** Default author and committer of release commits. */
export const RELEASE_IDENTITY: Ident = {
	name: "tallyrelease",
	email: "tallyrelease@users.noreply.github.com",
};

export interface CommitIdentity {
	author: Ident;
	committer: Ident;
}

/**
 * Identity from `GIT_AUTHOR_*` and `GIT_COMMITTER_*`; the committer defaults
 * to the author and each field to `RELEASE_IDENTITY` when empty.
 */
export const identityFromEnv = (
	env: Readonly<Record<string, string | undefined>>,
): CommitIdentity => {
	const pick = (key: string) => (env[key] === "" ? undefined : env[key]);
	const author = {
		name: pick("GIT_AUTHOR_NAME") ?? RELEASE_IDENTITY.name,
		email: pick("GIT_AUTHOR_EMAIL") ?? RELEASE_IDENTITY.email,
	};

	return {
		author,
		committer: {
			name: pick("GIT_COMMITTER_NAME") ?? author.name,
			email: pick("GIT_COMMITTER_EMAIL") ?? author.email,
		},
	};
};

export interface PushOptions {
	/** `--atomic`: every ref updates or none. */
	atomic?: boolean;
	/** `--force-with-lease` per remote ref: expected sha, `""` when the ref must not exist. */
	leases?: Readonly<Record<string, string>>;
	/** Auth header for an http(s) remote, replacing persisted checkout credentials. */
	token?: string | undefined;
}

/** Git writes of effects; never touches the working tree, index or HEAD. */
export interface GitWriter {
	/**
	 * Commit of `files` on top of `parent` with the configured identity and both
	 * dates set to `date`, so equal input gives an equal sha; not signed.
	 */
	commitFiles: (commit: {
		parent: string;
		files: ReadonlyMap<string, string>;
		message: string;
		date: string;
	}) => Promise<string>;
	/** Lightweight tag; no-op at `sha`, `E_TAG_EXISTS` elsewhere unless `force`. */
	tag: (name: string, sha: string, opts?: { force?: boolean }) => Promise<void>;
	/** Pushes refspecs to the remote; a failed lease is `E_PUSH_LEASE`. */
	push: (refspecs: readonly string[], opts?: PushOptions) => Promise<void>;
}

/** `GitWriter` backed by the `git` executable in `cwd`. */
export const gitWriter = (
	cwd: string,
	debug?: (message: string) => void,
	{
		identity = { author: RELEASE_IDENTITY, committer: RELEASE_IDENTITY },
		env,
		remote = "origin",
	}: { identity?: CommitIdentity; env?: Env; remote?: string } = {},
): GitWriter => {
	const ok = async (args: string[], vars?: Record<string, string>) =>
		(await gitOk(cwd, args, { debug, env, ...(vars && { vars }) })).trim();

	// Config through the environment keeps the token out of argv and debug output.
	const authEnv = async (token: string): Promise<Record<string, string>> => {
		let url: URL;
		try {
			url = new URL(await ok(["remote", "get-url", "--push", remote]));
		} catch {
			return {};
		}

		if (url.protocol !== "https:" && url.protocol !== "http:") {
			return {};
		}

		const key = `http.${url.origin}/.extraheader`;
		const basic = Buffer.from(`x-access-token:${token}`).toString("base64");

		// GIT_CONFIG_COUNT also drops inherited GIT_CONFIG_KEY_n entries.
		return {
			GIT_CONFIG_COUNT: "2",
			GIT_CONFIG_KEY_0: key,
			GIT_CONFIG_VALUE_0: "",
			GIT_CONFIG_KEY_1: key,
			GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
		};
	};

	return {
		commitFiles: async ({ parent, files, message, date }) => {
			const dir = await mkdtemp(join(tmpdir(), "tallyrelease-index-"));
			try {
				const index = { GIT_INDEX_FILE: join(dir, "index") };
				await ok(["read-tree", parent], index);

				const paths = [...files.keys()];
				if (paths.length > 0) {
					// Existing paths keep their mode (100755, 120000); new ones are 100644.
					const modes = new Map(
						(
							await ok(
								["--literal-pathspecs", "ls-files", "-s", "-z", "--", ...paths],
								index,
							)
						)
							.split("\0")
							.filter((line) => line !== "")
							.map((line) => {
								const [meta = "", path = ""] = line.split("\t");

								return [path, meta.split(" ")[0]] as const;
							}),
					);
					const blobs = await Promise.all(
						paths.map(async (path, i) => {
							const file = join(dir, `blob-${String(i)}`);
							await writeFile(file, files.get(path) ?? "");

							return file;
						}),
					);
					const shas = (
						await ok(["hash-object", "-w", "--no-filters", "--", ...blobs])
					).split("\n");
					await ok(
						[
							"update-index",
							"--add",
							...paths.flatMap((path, i) => [
								"--cacheinfo",
								`${modes.get(path) ?? "100644"},${shas[i] ?? ""},${path}`,
							]),
						],
						index,
					);
				}

				const tree = await ok(["write-tree"], index);

				return await ok(
					[
						"-c",
						"commit.gpgsign=false",
						"commit-tree",
						tree,
						"-p",
						parent,
						"-m",
						message,
					],
					{
						GIT_AUTHOR_NAME: identity.author.name,
						GIT_AUTHOR_EMAIL: identity.author.email,
						GIT_AUTHOR_DATE: date,
						GIT_COMMITTER_NAME: identity.committer.name,
						GIT_COMMITTER_EMAIL: identity.committer.email,
						GIT_COMMITTER_DATE: date,
					},
				);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
		// update-ref, unlike `git tag`, ignores tag.gpgSign.
		tag: async (name, sha, opts) => {
			const ref = `refs/tags/${name}`;
			const existing = await run(
				cwd,
				["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
				{ debug, env },
			);
			const current = existing.code === 0 ? existing.stdout.trim() : undefined;
			if (current === sha) {
				return;
			}

			if (current !== undefined && opts?.force !== true) {
				throw new TallyError(
					"E_TAG_EXISTS",
					`tag "${name}" exists at ${current}, not at ${sha}`,
					{ tag: name, sha: current, expected: sha },
				);
			}

			await ok(["update-ref", ref, sha]);
		},
		push: async (refspecs, opts = {}) => {
			const args = [
				"push",
				"--porcelain",
				"--no-verify",
				...(opts.atomic ? ["--atomic"] : []),
				...Object.entries(opts.leases ?? {}).map(
					([ref, expected]) => `--force-with-lease=${ref}:${expected}`,
				),
				remote,
				...refspecs,
			];
			const vars = {
				GIT_TERMINAL_PROMPT: "0",
				...(opts.token ? await authEnv(opts.token) : {}),
			};
			const result = await run(cwd, args, { debug, env, vars });
			if (result.code === 0) {
				return;
			}

			if (result.stdout.includes("(stale info)")) {
				throw new TallyError(
					"E_PUSH_LEASE",
					`push rejected, a remote ref moved since it was read: ${refspecs.join(" ")}`,
					{ refspecs },
				);
			}

			if (result.stdout.includes("(already exists)")) {
				throw new TallyError(
					"E_TAG_EXISTS",
					`push rejected, a tag exists on the remote at another commit: ${refspecs.join(" ")}`,
					{ refspecs },
				);
			}

			throw new Error(
				`git push failed (${String(result.code)}): ${result.stderr.trim()}`,
			);
		},
	};
};
