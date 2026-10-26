import { computePlan, loadWorkspace, withReleased } from "@tallyrelease/core";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	relative,
	resolve,
	sep,
} from "node:path";

import { githubContext } from "./ci/github-env.js";
import { cliCodes } from "./codes.js";
import { loadConfig } from "./config/load.js";
import { githubForge } from "./forge/github.js";
import { gitBlob, gitTreeFs, nodeFs } from "./fs-ctx.js";
import { git as runGit } from "./git/exec.js";
import { gitReader } from "./git/reader.js";
import { gitWriter, identityFromEnv } from "./git/writer.js";
import { painter } from "./output/paint.js";
import { builtinPlugins } from "./plugins/index.js";

import type { Env, GithubContext } from "./ci/github-env.js";
import type { Forge } from "./forge/forge.js";
import type { RepoGit } from "./git/reader.js";
import type { GitWriter } from "./git/writer.js";
import type { Writer } from "./output/writer.js";
import type {
	Plan,
	PlanOptions,
	ReadonlyFs,
	Warning,
	Workspace,
} from "@tallyrelease/core";

/** Injected environment of a cli run; `bin.ts` wires the real one. */
export interface Deps {
	env: Env;
	cwd: string;
	stdout: Writer;
	stderr: Writer;
	/** Defaults to the `git` executable at the repo root. */
	git?: RepoGit;
	/** Defaults to `node:fs` at the repo root. */
	fs?: ReadonlyFs;
	/** Files at a commit; defaults to the git object store at the repo root. */
	fsAt?: (ref: string) => ReadonlyFs;
	/** Defaults to GitHub when a token is available; used only with a token. */
	forge?: Forge;
	/** Defaults to the `git` executable at the repo root. */
	gitWriter?: GitWriter;
	/** Writes a file relative to the repo root; defaults to `node:fs`. */
	writeFile?: (path: string, content: string) => void;
	/** Writes a file at `path` as given, such as `--out`; defaults to `node:fs`. */
	writeOutFile?: (path: string, content: string) => void;
	/** Appends to a file at `path` as given, such as `$GITHUB_OUTPUT`; defaults to `node:fs`. */
	appendFile?: (path: string, content: string) => void;
	/** Defaults to the system clock. */
	clock?: () => Date;
}

export interface GlobalOptions {
	cwd?: string;
	config: string;
	token?: string;
	verbose?: boolean;
	/** Git remote to push to and read the repository from; defaults to `origin`. */
	remote?: string;
}

/** Resolved dependencies shared by all commands. */
export interface Session {
	readonly cwd: string;
	readonly root: string;
	readonly env: Env;
	readonly stdout: Writer;
	readonly fs: ReadonlyFs;
	readonly git: RepoGit;
	readonly github: GithubContext | undefined;
	/** Undefined without a token. */
	readonly forge: Forge | undefined;
	/** `--token`, else `GITHUB_TOKEN`. */
	readonly token: string | undefined;
	/** `--remote`, else `origin`. */
	readonly remote: string;
	readonly gitWriter: GitWriter;
	readonly writeFile: (path: string, content: string) => void;
	readonly writeOutFile: (path: string, content: string) => void;
	readonly appendFile: (path: string, content: string) => void;
	readonly clock: () => Date;
	/** Web URL of the repository for changelog links, null when unknown. */
	readonly repoUrl: () => Promise<string | null>;
	readonly workspace: () => Promise<Workspace>;
	/** Content of `path` at commit `ref`, undefined when absent. */
	readonly readAt: (ref: string, path: string) => string | undefined;
	/**
	 * Runs `use` with the workspace and files at commit `ref`, or of the
	 * working tree when `ref` is null; the config is always read from the
	 * working tree.
	 */
	readonly workspaceAt: <T>(
		ref: string | null,
		use: (workspace: Workspace, fs: ReadonlyFs) => Promise<T>,
	) => Promise<T>;
	/**
	 * `computePlan` with the workspace and files of `workspaceAt(ref)`;
	 * `fill.released` fills `released` (`withReleased`).
	 */
	readonly planAt: (
		ref: string | null,
		opts: Omit<PlanOptions, "fs">,
		fill?: { released: boolean },
	) => Promise<Plan>;
	readonly warn: (warnings: readonly Warning[]) => void;
}

/**
 * Https web URL of a git remote without credentials or `.git`, null when not
 * recognised. URL remotes keep the hostname (no port), scp-style `user@host:path`
 * maps to `https://host/path`.
 */
export const webUrl = (remote: string): string | null => {
	const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(remote);
	let host: string;
	let path: string;
	if (scp) {
		host = scp[1] ?? "";
		path = scp[2] ?? "";
	} else {
		let url: URL;
		try {
			url = new URL(remote);
		} catch {
			return null;
		}

		if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) {
			return null;
		}

		host = url.hostname;
		path = url.pathname;
	}

	path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");

	return host && path ? `https://${host}/${path}` : null;
};

export const createSession = (deps: Deps, opts: GlobalOptions): Session => {
	const root = resolve(deps.cwd, opts.cwd ?? ".");
	const debug = opts.verbose
		? (message: string) => deps.stderr.write(`debug: ${message}\n`)
		: undefined;
	const fs = deps.fs ?? nodeFs(root);
	const github = githubContext(deps.env);
	const token = opts.token ?? deps.env["GITHUB_TOKEN"];
	const remote = opts.remote ?? "origin";
	const configPath = relative(root, resolve(root, opts.config))
		.split(sep)
		.join("/");
	// Injected git or fs means there is no repository on disk to query.
	const onDisk = deps.git === undefined && deps.fs === undefined;

	const assertRepoRoot = async () => {
		if (!existsSync(root)) {
			throw cliCodes.error(
				"E_CWD_MISSING",
				`directory "${root}" does not exist`,
				{
					cwd: root,
				},
			);
		}

		const result = await runGit(
			root,
			["rev-parse", "--show-toplevel", "--show-prefix"],
			{ debug, env: deps.env },
		);
		if (result.code !== 0) {
			throw cliCodes.error("E_NOT_A_REPO", `not a git repository: ${root}`, {
				cwd: root,
			});
		}

		const [toplevel = "", prefix = ""] = result.stdout.split("\n");
		if (prefix !== "") {
			throw cliCodes.error(
				"E_NOT_REPO_ROOT",
				`"${root}" is below the repository root "${toplevel}"; run from the root or pass --cwd`,
				{ cwd: root, toplevel },
			);
		}
	};

	// GITHUB_REPOSITORY, else the remote url, else the directory name.
	const repoName = async () => {
		const fromEnv = deps.env["GITHUB_REPOSITORY"]?.split("/")[1];
		if (fromEnv) {
			return fromEnv;
		}

		if (onDisk) {
			const url = await runGit(root, ["remote", "get-url", remote], {
				debug,
				env: deps.env,
			});
			const name =
				url.code === 0
					? /([^/:]+?)(?:\.git)?\/*$/.exec(url.stdout.trim())?.[1]
					: undefined;
			if (name) {
				return name;
			}
		}

		return basename(root);
	};

	// GITHUB_SERVER_URL and GITHUB_REPOSITORY, else the remote url as https.
	const repoUrl = async () => {
		const server = deps.env["GITHUB_SERVER_URL"];
		const repository = deps.env["GITHUB_REPOSITORY"];
		if (server && repository) {
			return `${server.replace(/\/+$/, "")}/${repository}`;
		}

		if (!onDisk) {
			return null;
		}

		const url = await runGit(root, ["remote", "get-url", remote], {
			debug,
			env: deps.env,
		});

		return url.code === 0 ? webUrl(url.stdout.trim()) : null;
	};

	const repoGit = deps.git ?? gitReader(root, debug, { env: deps.env, remote });
	const blobAt = gitBlob(root, deps.env);

	const workspaceAt = async <T>(
		ref: string | null,
		use: (workspace: Workspace, files: ReadonlyFs) => Promise<T>,
	): Promise<T> => {
		if (onDisk) {
			await assertRepoRoot();
		}

		const config = loadConfig(fs, configPath);
		const files =
			ref === null ? fs : (deps.fsAt?.(ref) ?? gitTreeFs(root, ref, deps.env));
		const workspace = await loadWorkspace({
			config,
			configFile: configPath,
			plugins: Object.values(builtinPlugins),
			fs: files,
			repo: { name: await repoName() },
			...(debug && { debug }),
		});

		return await use(workspace, files);
	};

	return {
		cwd: deps.cwd,
		root,
		env: deps.env,
		stdout: deps.stdout,
		fs,
		git: repoGit,
		github,
		forge: token
			? (deps.forge ?? githubForge({ token, baseUrl: github?.apiUrl }))
			: undefined,
		token,
		remote,
		gitWriter:
			deps.gitWriter ??
			gitWriter(root, debug, {
				identity: identityFromEnv(deps.env),
				env: deps.env,
				remote,
			}),
		writeFile:
			deps.writeFile ??
			((path, content) => {
				const file = resolve(root, path);
				const rel = relative(root, file);
				if (
					rel === "" ||
					rel === ".." ||
					rel.startsWith(`..${sep}`) ||
					isAbsolute(rel)
				) {
					throw cliCodes.error(
						"E_PATH_OUTSIDE_ROOT",
						`"${path}" is outside the repository root`,
						{ path },
					);
				}

				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, content);
			}),
		writeOutFile:
			deps.writeOutFile ??
			((path, content) => {
				writeFileSync(path, content);
			}),
		appendFile:
			deps.appendFile ??
			((path, content) => {
				appendFileSync(path, content);
			}),
		clock: deps.clock ?? (() => new Date()),
		repoUrl,
		workspace: async () =>
			await workspaceAt(null, (workspace) => Promise.resolve(workspace)),
		readAt: (ref, path) =>
			deps.fsAt ? deps.fsAt(ref).read(path) : blobAt(ref, path),
		workspaceAt,
		planAt: async (ref, opts, fill) =>
			await workspaceAt(ref, async (workspace, files) => {
				const plan = await computePlan(workspace, repoGit, {
					...opts,
					fs: files,
					...(debug && { debug }),
				});

				return fill?.released
					? await withReleased(workspace, plan, { git: repoGit })
					: plan;
			}),
		warn: (warnings) => {
			const paint = painter(deps.stderr);
			for (const w of warnings) {
				deps.stderr.write(
					`${paint("yellow", `warning[${w.code}]`)}: ${w.plugin ? `${w.plugin}: ` : ""}${w.message}\n`,
				);
			}
		},
	};
};

/** PR head branch, else the GitHub ref name, else the checked-out branch, else `HEAD`. */
export const branchName = async (
	session: Pick<Session, "git" | "github">,
): Promise<string> =>
	session.github?.headRef ??
	session.github?.refName ??
	(await session.git.branch()) ??
	"HEAD";
