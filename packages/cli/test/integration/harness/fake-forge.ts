import { TallyError } from "@tallyrelease/core";
import { createHash } from "node:crypto";

import { ForgeConflictError, ForgeNotFoundError } from "../../../src/index.js";

import type {
	Forge,
	GitWriter,
	NewRelease,
	ReleasePr,
	WorkflowRunQuery,
} from "../../../src/index.js";
import type { Dag } from "@tallyrelease/core/testing";

const pr = (remote: { prs: FakePr[] }, number: number): FakePr => {
	const found = remote.prs.find((p) => p.number === number);
	if (!found) {
		throw new ForgeNotFoundError(`no PR #${String(number)}`, 404);
	}

	return found;
};

const view = ({
	title: _t,
	state: _s,
	comments: _c,
	...p
}: FakePr): ReleasePr => ({ ...p, labels: [...p.labels] });

export interface FakePr extends ReleasePr {
	title: string;
	state: "open" | "closed";
	comments: string[];
}

/** Remote repository and forge state shared by `fakeForge` and `fakeGitWriter`. */
export interface MemoryRemote {
	/** Commits made by `fakeGitWriter`, with the files they change. */
	commits: Map<
		string,
		{
			parent: string;
			files: Record<string, string>;
			deletes?: string[];
			message: string;
		}
	>;
	/** Branch name to commit id. */
	branches: Map<string, string>;
	/** Pushed tags: name to commit id. */
	tags: Map<string, string>;
	prs: FakePr[];
	releases: (NewRelease & { id: number })[];
	/** Forge and writer calls in order: method name, then arguments. */
	calls: [string, ...unknown[]][];
}

export const memoryRemote = (): MemoryRemote => ({
	commits: new Map(),
	branches: new Map(),
	tags: new Map(),
	prs: [],
	releases: [],
	calls: [],
});

/** In-memory `Forge` over `remote`; serves canned run head shas and records queries. */
export const fakeForge = (
	runs: string[] = [],
	remote: MemoryRemote = memoryRemote(),
): Forge & { queries: WorkflowRunQuery[]; remote: MemoryRemote } => {
	const queries: WorkflowRunQuery[] = [];
	const call = (method: string, ...args: unknown[]) => {
		remote.calls.push([method, ...args]);
	};

	return {
		queries,
		remote,
		lastSuccessfulPushRuns: async (query) => {
			queries.push(query);

			return await Promise.resolve((query.page ?? 1) === 1 ? runs : []);
		},
		releasePrs: async (_repo, { base, state }) => {
			const prs = remote.prs
				.filter(
					(p) =>
						p.base === base &&
						p.labels.includes("tallyrelease: pending") &&
						(state === "open" ? p.state === "open" : p.mergedAt !== null),
				)
				.sort((a, b) =>
					state === "open"
						? a.number - b.number
						: (a.mergedAt ?? "").localeCompare(b.mergedAt ?? ""),
				);

			return await Promise.resolve(prs.map(view));
		},
		openPr: async (_repo, { head, base }) => {
			const p = remote.prs.find(
				(c) => c.head === head && c.base === base && c.state === "open",
			);

			return await Promise.resolve(p && view(p));
		},
		createPr: async (_repo, { head, base, title, body }) => {
			call("createPr", { head, base, title });
			if (remote.prs.some((p) => p.head === head && p.state === "open")) {
				throw new ForgeConflictError(
					`A pull request already exists for ${head}`,
					422,
				);
			}

			const number = remote.prs.length + 1;
			remote.prs.push({
				number,
				url: `pull/${String(number)}`,
				head,
				headSha: remote.branches.get(head) ?? "",
				base,
				title,
				body,
				labels: [],
				state: "open",
				comments: [],
				mergedAt: null,
				mergeCommitSha: null,
			});

			return await Promise.resolve(number);
		},
		updatePr: async (_repo, number, update) => {
			call("updatePr", number, update);
			Object.assign(pr(remote, number), update);
			await Promise.resolve();
		},
		closePr: async (_repo, number, comment) => {
			call("closePr", number);
			const p = pr(remote, number);
			p.comments.push(comment);
			p.state = "closed";
			await Promise.resolve();
		},
		setLabel: async (_repo, number, { label, comment }) => {
			call("setLabel", number, label);
			const p = pr(remote, number);
			p.labels = [
				...p.labels.filter((l) => !l.startsWith("tallyrelease:")),
				label,
			];
			if (comment !== undefined) {
				p.comments.push(comment);
			}

			await Promise.resolve();
		},
		branchSha: async (_repo, branch) =>
			await Promise.resolve(remote.branches.get(branch)),
		prForCommit: async (_repo, sha) => {
			const p = remote.prs.find((c) => c.mergeCommitSha === sha);

			return await Promise.resolve(
				p && { number: p.number, url: p.url, labels: [...p.labels] },
			);
		},
		releaseByTag: async (_repo, name) => {
			const release = remote.releases.find((r) => r.tag === name);

			return await Promise.resolve(
				release && { id: release.id, url: `release/${release.tag}` },
			);
		},
		createRelease: async (_repo, release) => {
			call("createRelease", release);
			if (remote.releases.some((r) => r.tag === release.tag)) {
				throw new ForgeConflictError(
					`A release already exists for ${release.tag}`,
					422,
				);
			}

			const id = remote.releases.length + 1;
			remote.releases.push({ ...release, id });

			return await Promise.resolve({ id, url: `release/${release.tag}` });
		},
	};
};

/**
 * `GitWriter` over `remote`; commit ids are hashes of the inputs. `tags` are
 * the run's local tags; `push` copies the pushed ones to the remote.
 */
export const fakeGitWriter = (
	remote: MemoryRemote,
): GitWriter & { tags: Map<string, string> } => {
	const tags = new Map<string, string>();
	const localTag = (name: string) => tags.get(name) ?? remote.tags.get(name);

	return {
		tags,
		commitFiles: async ({ parent, files, deletes = [], message, date }) => {
			const entries = [...files].sort(([a], [b]) => (a < b ? -1 : 1));
			const removed = [...deletes].sort();
			const input = [parent, entries, message, date];
			const id = createHash("sha1")
				.update(
					JSON.stringify(removed.length > 0 ? [...input, removed] : input),
				)
				.digest("hex");
			remote.commits.set(id, {
				parent,
				files: Object.fromEntries(entries),
				...(removed.length > 0 && { deletes: removed }),
				message,
			});

			return await Promise.resolve(id);
		},
		tag: async (name, sha, opts) => {
			const current = localTag(name);
			if (current !== undefined && current !== sha && opts?.force !== true) {
				throw new TallyError("E_TAG_EXISTS", `tag "${name}" exists`, {
					tag: name,
				});
			}

			tags.set(name, sha);
			await Promise.resolve();
		},
		// Every push is atomic here: leases and tags are checked before any ref changes.
		push: async (refspecs, opts = {}) => {
			remote.calls.push(["push", refspecs, opts]);
			for (const [ref, expected] of Object.entries(opts.leases ?? {})) {
				const branch = ref.replace(/^refs\/heads\//, "");
				if ((remote.branches.get(branch) ?? "") !== expected) {
					throw new TallyError("E_PUSH_LEASE", `stale lease on ${ref}`, {
						refspecs,
					});
				}
			}

			const updates = refspecs.map((spec) => {
				const [src = "", dst = src] = spec.replace(/^\+/, "").split(":");
				const sha = src.startsWith("refs/tags/")
					? localTag(src.slice("refs/tags/".length))
					: src;
				const current = remote.tags.get(dst.slice("refs/tags/".length));
				if (
					dst.startsWith("refs/tags/") &&
					current !== undefined &&
					current !== sha &&
					!spec.startsWith("+")
				) {
					throw new TallyError("E_TAG_EXISTS", `remote tag ${dst} exists`, {
						refspecs,
					});
				}

				return { sha, dst };
			});

			for (const { sha, dst } of updates) {
				if (dst.startsWith("refs/tags/")) {
					remote.tags.set(dst.slice("refs/tags/".length), sha ?? "");
				} else if (sha === "" || sha === undefined) {
					remote.branches.delete(dst.slice("refs/heads/".length));
				} else {
					const branch = dst.slice("refs/heads/".length);
					remote.branches.set(branch, sha);
					for (const p of remote.prs) {
						if (p.head === branch && p.state === "open") {
							p.headSha = sha;
						}
					}
				}
			}

			await Promise.resolve();
		},
	};
};

/**
 * `dag` plus a squash merge of PR `number` (its head commit's files and
 * deletes on top of HEAD, id `merge-<number>`), or with `mergeCommit` a merge commit whose
 * second parent is the PR head; marks the PR merged.
 */
export const mergePr = (
	dag: Dag,
	remote: MemoryRemote,
	number: number,
	{ mergeCommit = false }: { mergeCommit?: boolean } = {},
): Dag => {
	const p = pr(remote, number);
	const head = remote.commits.get(p.headSha);
	const id = `merge-${String(number)}`;
	p.state = "closed";
	p.mergedAt = new Date(
		Date.UTC(2025, 0, 1, 0, dag.commits.length),
	).toISOString();
	p.mergeCommitSha = id;
	const tip = dag.commits.at(-1)?.id ?? "";
	const files = {
		...head?.files,
		...Object.fromEntries((head?.deletes ?? []).map((path) => [path, null])),
	};

	return {
		...dag,
		commits: mergeCommit
			? [
					...dag.commits,
					{
						id: p.headSha,
						parents: [head?.parent ?? tip],
						message: p.title,
						files,
					},
					{
						id,
						parents: [tip, p.headSha],
						message: `Merge pull request #${String(number)} from acme/${p.head}\n\n${p.title}`,
						date: p.mergedAt,
					},
				]
			: [
					...dag.commits,
					{
						id,
						message: `${p.title} (#${String(number)})\n\n${p.body}`,
						date: p.mergedAt,
						files,
					},
				],
	};
};
