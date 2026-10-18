import { gitOk, git as run } from "./exec.js";

import type { Env } from "../ci/github-env.js";
import type {
	GitReader,
	MaybePromise,
	RawCommit,
	TagRef,
} from "@tallyrelease/core";

const byName = (a: TagRef, b: TagRef) =>
	a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const lines = (out: string) => out.split("\n").filter((l) => l !== "");

const nulFields = (out: string) => out.split("\0").filter((l) => l !== "");

/** `GitReader` plus the queries the cli needs to resolve a build base. */
export interface RepoGit extends GitReader {
	/** Full commit sha of `ref`, undefined if it does not resolve locally. */
	resolve: (ref: string) => MaybePromise<string | undefined>;
	/** Best common ancestor, undefined if none. */
	mergeBase: (a: string, b: string) => MaybePromise<string | undefined>;
	isShallow: () => MaybePromise<boolean>;
	/** Current branch, undefined when detached. */
	branch: () => MaybePromise<string | undefined>;
	/** Target of `<remote>/HEAD`, for example `origin/main`; undefined if unset. */
	defaultBranch: () => MaybePromise<string | undefined>;
	/** Committer date of `ref`, ISO 8601. */
	commitDate: (ref: string) => MaybePromise<string>;
}

/** `RepoGit` backed by the `git` executable in `cwd`. */
export const gitReader = (
	cwd: string,
	debug?: (message: string) => void,
	{ env, remote = "origin" }: { env?: Env; remote?: string } = {},
): RepoGit => {
	const ok = (args: string[]) => gitOk(cwd, args, { debug, env });
	const resolve = async (ref: string) => {
		const result = await run(
			cwd,
			["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
			{ debug, env },
		);

		return result.code === 0 ? result.stdout.trim() : undefined;
	};

	const tagRefs = async (extra: string[]): Promise<TagRef[]> => {
		const refs = lines(
			await ok([
				"for-each-ref",
				...extra,
				"--format=%(refname:strip=2)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)",
				"refs/tags",
			]),
		).map(async (line): Promise<TagRef | undefined> => {
			const [name = "", type = "", sha = "", peeledType = "", peeled = ""] =
				line.split("\0");
			if (peeledType === "commit") {
				return { name, sha: peeled };
			}

			if (type === "commit") {
				return { name, sha };
			}

			// Older git peels one level only; tags of tags need a full peel.
			const commit = await resolve(sha);

			return commit === undefined ? undefined : { name, sha: commit };
		});

		return (await Promise.all(refs))
			.filter((t) => t !== undefined)
			.sort(byName);
	};

	const firstParents = new Map<string, Promise<Set<string>>>();
	const firstParentSet = (ref: string) => {
		let set = firstParents.get(ref);
		if (set === undefined) {
			set = ok(["rev-list", "--first-parent", ref]).then(
				(out) => new Set(lines(out)),
			);
			firstParents.set(ref, set);
		}

		return set;
	};

	const introductions = new Map<string, Promise<string | null>>();

	const range = (from: string | null, to: string) =>
		from === null ? [to] : [to, `^${from}`];

	return {
		tags: () => tagRefs([]),
		tagsMerged: (ref) => tagRefs([`--merged=${ref}`]),
		isAncestor: async (a, b) => {
			const result = await run(cwd, ["merge-base", "--is-ancestor", a, b], {
				debug,
				env,
			});
			if (result.code > 1) {
				throw new Error(`git merge-base failed: ${result.stderr.trim()}`);
			}

			return result.code === 0;
		},
		isFirstParentAncestor: async (a, b) => {
			const chain = await firstParentSet(b);
			if (chain.has(a)) {
				return true;
			}

			const sha = await resolve(a);

			return sha !== undefined && chain.has(sha);
		},
		log: async (from, to) => {
			const out = await ok([
				"log",
				"-z",
				"--no-show-signature",
				"--no-color",
				"--no-merges",
				"--topo-order",
				"--no-renames",
				"--name-only",
				"--format=%x1e%H%x00%P%x00%cI%x00%B%x00",
				...range(from, to),
				"--",
			]);

			return out
				.split("\x1e")
				.slice(1)
				.map((record): RawCommit => {
					const [sha = "", parents = "", date = "", message = "", ...rest] =
						record.split("\0");
					// Files follow the header as "\0\n" plus NUL-terminated paths.
					const files = nulFields(rest.join("\0").replace(/^\0\n?/, ""));

					return {
						sha,
						parents: parents.split(" ").filter((p) => p !== ""),
						message: message.trimEnd(),
						files: files.sort(),
						date,
					};
				});
		},
		countFirstParent: async (from, to) =>
			Number(
				(
					await ok([
						"rev-list",
						"--count",
						"--first-parent",
						...range(from, to),
					])
				).trim(),
			),
		diffFiles: async (from, to) =>
			nulFields(
				await ok([
					"diff",
					"-z",
					"--no-color",
					"--name-only",
					"--no-renames",
					from,
					to,
					"--",
				]),
			).sort(),
		introduced: (path, to) => {
			const key = `${to}\0${path}`;
			let intro = introductions.get(key);
			if (intro === undefined) {
				intro = ok([
					"log",
					"--no-show-signature",
					"--first-parent",
					"--reverse",
					"--format=%H",
					to,
					"--",
					`:(top,literal)${path}`,
				]).then((out) => lines(out)[0] ?? null);
				introductions.set(key, intro);
			}

			return intro;
		},
		resolve,
		mergeBase: async (a, b) => {
			const result = await run(cwd, ["merge-base", a, b], {
				debug,
				env,
			});

			return result.code === 0 ? result.stdout.trim() : undefined;
		},
		isShallow: async () =>
			(await ok(["rev-parse", "--is-shallow-repository"])).trim() === "true",
		branch: async () => {
			const result = await run(
				cwd,
				["symbolic-ref", "--quiet", "--short", "HEAD"],
				{ debug, env },
			);

			return result.code === 0 ? result.stdout.trim() : undefined;
		},
		defaultBranch: async () => {
			const result = await run(
				cwd,
				["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
				{ debug, env },
			);

			return result.code === 0 ? result.stdout.trim() : undefined;
		},
		commitDate: async (ref) =>
			(await ok(["log", "-1", "--format=%cI", ref, "--"])).trim(),
	};
};
