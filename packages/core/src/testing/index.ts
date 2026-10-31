import picomatch from "picomatch/posix.js";

import { compare, uniqueSorted } from "../util.js";

import type {
	Ctx,
	GitReader,
	RawCommit,
	ReadonlyFs,
	TagRef,
} from "../plugin.js";

const SKIPPED = new Set([".git", "node_modules"]);

type Tree = ReadonlyMap<string, string>;

interface Node {
	id: string;
	parents: string[];
	message: string;
	date: string;
	tree: Tree;
	/** Inclusive ancestor set. */
	ancestors: ReadonlySet<string>;
}

const changed = (a: Tree, b: Tree): string[] =>
	uniqueSorted([...a.keys(), ...b.keys()]).filter((p) => a.get(p) !== b.get(p));

/** In-memory `ReadonlyFs` over a path-to-content map. */
export const memoryFs = (files: Record<string, string>): ReadonlyFs => {
	const paths = Object.keys(files).sort(compare);
	const dirs = uniqueSorted(
		paths.flatMap((p) => {
			const parts = p.split("/");

			return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
		}),
	);
	const visible = (p: string) => {
		const segments = p.split("/");

		return segments[0] !== "vendor" && !segments.some((s) => SKIPPED.has(s));
	};

	return {
		read: (path) => (Object.hasOwn(files, path) ? files[path] : undefined),
		exists: (path) =>
			path === "." || Object.hasOwn(files, path) || dirs.includes(path),
		glob: (patterns, opts) => {
			const match = picomatch(patterns, { dot: true });

			return (opts?.dirs ? dirs : paths).filter((p) => visible(p) && match(p));
		},
	};
};

export interface MemoryCtxOptions<O> {
	options?: O;
	/** Defaults to `repo`. */
	repo?: string;
	files?: Record<string, string>;
}

/** Plugin `Ctx` over `memoryFs`; collects `log.warn` messages in `warnings`. */
export const memoryCtx = <O = Record<string, never>>(
	opts: MemoryCtxOptions<O> = {},
): Ctx<O> & { readonly warnings: string[] } => {
	const warnings: string[] = [];
	const options: unknown = opts.options ?? {};

	return {
		options: options as O,
		repo: { name: opts.repo ?? "repo" },
		fs: memoryFs(opts.files ?? {}),
		log: { warn: (msg) => warnings.push(msg), debug: () => undefined },
		warnings,
	};
};

export interface DagCommit {
	id: string;
	/** Defaults to the previous commit in the list, none for the first. */
	parents?: string[];
	message?: string;
	/** Committer date, ISO 8601. */
	date?: string;
	/**
	 * Changes applied on top of the parents' tree; `null` deletes. A merge
	 * starts from a three-way merge of its parents (later parents win conflicts).
	 */
	files?: Record<string, string | null>;
}

export interface DagTag {
	name: string;
	commit: string;
	annotated?: boolean;
}

/** Commit graph in parent-before-child order. Commit ids double as shas. */
export interface Dag {
	commits: DagCommit[];
	tags?: DagTag[];
}

export interface MemoryGit extends GitReader {
	/** File contents at a commit id, tag name or `HEAD` (the last commit). */
	tree: (ref: string) => Record<string, string>;
	/** Parent commit ids of a ref. */
	parents: (ref: string) => string[];
}

/** In-memory `GitReader` over a commit graph. */
export const memoryGit = (dag: Dag): MemoryGit => {
	const nodes = new Map<string, Node>();
	const node = (ref: string): Node => {
		const id = ref === "HEAD" ? dag.commits.at(-1)?.id : ref;
		const found =
			nodes.get(id ?? "") ??
			nodes.get(dag.tags?.find((t) => t.name === ref)?.commit ?? "");
		if (!found) {
			throw new Error(`unknown ref "${ref}"`);
		}

		return found;
	};

	const mergeBase = (a: Node, b: Node): Tree => {
		const common = [...a.ancestors].filter((id) => b.ancestors.has(id));
		const best = common.find(
			(id) => !common.some((o) => o !== id && node(o).ancestors.has(id)),
		);

		return best === undefined ? new Map() : node(best).tree;
	};

	dag.commits.forEach((c, i) => {
		const prior = dag.commits[i - 1];
		const parents = (c.parents ?? (prior ? [prior.id] : [])).map(node);
		const [first, ...others] = parents;
		const tree = new Map(first?.tree);
		for (const other of others) {
			const base = first ? mergeBase(first, other) : new Map<string, string>();
			for (const path of changed(base, other.tree)) {
				const content = other.tree.get(path);
				if (content === undefined) {
					tree.delete(path);
				} else {
					tree.set(path, content);
				}
			}
		}

		for (const [path, content] of Object.entries(c.files ?? {})) {
			if (content === null) {
				tree.delete(path);
			} else {
				tree.set(path, content);
			}
		}

		nodes.set(c.id, {
			id: c.id,
			parents: parents.map((p) => p.id),
			message: c.message ?? c.id,
			date: c.date ?? new Date(Date.UTC(2024, 0, 1, 0, i)).toISOString(),
			tree,
			ancestors: new Set([c.id, ...parents.flatMap((p) => [...p.ancestors])]),
		});
	});

	const firstParentChain = (to: string): Node[] => {
		const chain: Node[] = [];
		for (let n: Node | undefined = node(to); n;) {
			chain.push(n);
			const parent: string | undefined = n.parents[0];
			n = parent === undefined ? undefined : node(parent);
		}

		return chain;
	};

	const tagRefs = (): TagRef[] =>
		(dag.tags ?? [])
			.map((t) => ({ name: t.name, sha: node(t.commit).id }))
			.sort((a, b) => compare(a.name, b.name));
	const excluded = (from: string | null): ReadonlySet<string> =>
		from === null ? new Set() : node(from).ancestors;

	return {
		tags: tagRefs,
		tagsMerged: (ref) => {
			const reachable = node(ref).ancestors;

			return tagRefs().filter((t) => reachable.has(t.sha));
		},
		isAncestor: (a, b) => node(b).ancestors.has(node(a).id),
		isFirstParentAncestor: (a, b) => {
			const id = node(a).id;

			return firstParentChain(b).some((n) => n.id === id);
		},
		log: (from, to) => {
			const skip = excluded(from);
			const reachable = node(to).ancestors;

			return dag.commits
				.map((c) => node(c.id))
				.filter((n) => reachable.has(n.id) && !skip.has(n.id))
				.filter((n) => n.parents.length <= 1)
				.reverse()
				.map((n): RawCommit => ({
					sha: n.id,
					parents: [...n.parents],
					message: n.message,
					files: changed(
						n.parents[0] === undefined ? new Map() : node(n.parents[0]).tree,
						n.tree,
					),
					date: n.date,
				}));
		},
		countFirstParent: (from, to) => {
			const skip = excluded(from);

			return firstParentChain(to).filter((n) => !skip.has(n.id)).length;
		},
		diffFiles: (from, to) => changed(node(from).tree, node(to).tree),
		introduced: (path, to) => {
			const under = (p: string) => p === path || p.startsWith(`${path}/`);
			const intro = firstParentChain(to)
				.reverse()
				.find((n) =>
					changed(
						n.parents[0] === undefined ? new Map() : node(n.parents[0]).tree,
						n.tree,
					).some(under),
				);

			return intro?.id ?? null;
		},
		tree: (ref) => Object.fromEntries(node(ref).tree),
		parents: (ref) => [...node(ref).parents],
	};
};
