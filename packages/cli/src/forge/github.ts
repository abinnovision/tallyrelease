import { Octokit } from "@octokit/rest";

import {
	ForgeConflictError,
	ForgeError,
	ForgeNotFoundError,
} from "./errors.js";
import { LABELS } from "./forge.js";

import type { Forge, ReleasePr, RepoRef } from "./forge.js";

const LABEL_COLORS: Readonly<Record<string, string>> = {
	[LABELS.pending]: "fbca04",
	[LABELS.released]: "0e8a16",
	[LABELS.stale]: "d93f0b",
};

/** `ForgeError` of a failed Octokit request; `ForgeNotFoundError` on 404. */
const forgeError = (error: unknown): ForgeError => {
	const raw = (error as { status?: unknown } | null)?.status;
	const status = typeof raw === "number" ? raw : undefined;
	const message = error instanceof Error ? error.message : String(error);
	const Type = status === 404 ? ForgeNotFoundError : ForgeError;

	return new Type(message, status, { cause: error });
};

/** Resolves `undefined` when the request fails with one of `statuses`. */
const unless = async <T>(
	request: Promise<T>,
	...statuses: number[]
): Promise<T | undefined> => {
	try {
		return await request;
	} catch (error) {
		if (error instanceof ForgeError && statuses.includes(error.status ?? 0)) {
			return undefined;
		}

		throw error;
	}
};

/** Rethrows a 422 as `ForgeConflictError`: the PR or release exists. */
const conflict = async <T>(request: Promise<T>): Promise<T> => {
	try {
		return await request;
	} catch (error) {
		if (error instanceof ForgeError && error.status === 422) {
			throw new ForgeConflictError(error.message, error.status, {
				cause: error,
			});
		}

		throw error;
	}
};

interface PullData {
	number: number;
	html_url: string;
	head: { ref: string; sha: string };
	base: { ref: string };
	body: string | null;
	labels: { name?: string }[];
	merged_at: string | null;
	merge_commit_sha: string | null;
}

const releasePr = (pr: PullData): ReleasePr => ({
	number: pr.number,
	url: pr.html_url,
	head: pr.head.ref,
	headSha: pr.head.sha,
	base: pr.base.ref,
	body: pr.body ?? "",
	labels: pr.labels.map((l) => l.name ?? ""),
	mergedAt: pr.merged_at,
	mergeCommitSha: pr.merged_at === null ? null : pr.merge_commit_sha,
});

export interface GithubForgeOptions {
	token: string;
	/** `GITHUB_API_URL`, defaults to the public API. */
	baseUrl?: string | undefined;
}

/** `Forge` backed by the GitHub REST API. */
export const githubForge = (opts: GithubForgeOptions): Forge => {
	const octokit = new Octokit({
		auth: opts.token,
		baseUrl: opts.baseUrl ?? "https://api.github.com",
		// Failed requests surface as errors; the request log would also print expected 404s.
		log: {
			debug: () => undefined,
			info: () => undefined,
			warn: console.warn,
			error: () => undefined,
		},
	});
	// Registered last, so Octokit's own hooks still see the original error.
	octokit.hook.wrap("request", async (request, options) => {
		try {
			return await request(options);
		} catch (error) {
			throw forgeError(error);
		}
	});

	const comment = async (repo: RepoRef, number: number, body: string) => {
		await octokit.rest.issues.createComment({
			...repo,
			issue_number: number,
			body,
		});
	};

	// 404: removed concurrently.
	const removeLabel = async (repo: RepoRef, number: number, name: string) => {
		await unless(
			octokit.rest.issues.removeLabel({ ...repo, issue_number: number, name }),
			404,
		);
	};

	const ensureLabel = async (repo: RepoRef, name: string) => {
		if (await unless(octokit.rest.issues.getLabel({ ...repo, name }), 404)) {
			return;
		}

		// 422: created concurrently.
		await unless(
			octokit.rest.issues.createLabel({
				...repo,
				name,
				color: LABEL_COLORS[name] ?? "ededed",
			}),
			422,
		);
	};

	return {
		lastSuccessfulPushRuns: async ({ owner, repo, workflow, branch, page }) => {
			// A renamed or deleted workflow has no runs to build on.
			const runs = await unless(
				octokit.rest.actions.listWorkflowRuns({
					owner,
					repo,
					workflow_id: workflow,
					branch,
					status: "success",
					event: "push",
					per_page: 100,
					page,
				}),
				404,
			);

			return runs?.data.workflow_runs.map((run) => run.head_sha) ?? [];
		},
		// Issues API: label listing has no search index lag.
		releasePrs: async (repo, { base, state }) => {
			const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
				...repo,
				labels: LABELS.pending,
				state: state === "open" ? "open" : "closed",
				sort: "created",
				direction: "asc",
				per_page: 100,
			});
			const pulls = [];
			for (const issue of issues) {
				if (issue.pull_request !== undefined) {
					// eslint-disable-next-line no-await-in-loop -- sequential, avoids secondary rate limits
					const { data } = await octokit.rest.pulls.get({
						...repo,
						pull_number: issue.number,
					});
					pulls.push(data);
				}
			}

			return pulls
				.filter(
					(pr) =>
						pr.base.ref === base &&
						// A deleted fork's repo is null.
						(pr.head.repo as { full_name: string } | null)?.full_name ===
							`${repo.owner}/${repo.repo}` &&
						(state === "open" || pr.merged_at !== null),
				)
				.map(releasePr)
				.sort((a, b) =>
					state === "open" || a.mergedAt === b.mergedAt
						? a.number - b.number
						: (a.mergedAt ?? "") < (b.mergedAt ?? "")
							? -1
							: 1,
				);
		},
		openPr: async (repo, { head, base }) => {
			const { data } = await octokit.rest.pulls.list({
				...repo,
				head: `${repo.owner}:${head}`,
				base,
				state: "open",
			});

			return data[0] && releasePr(data[0]);
		},
		createPr: async (repo, pr) =>
			(await conflict(octokit.rest.pulls.create({ ...repo, ...pr }))).data
				.number,
		updatePr: async (repo, number, update) => {
			await octokit.rest.pulls.update({
				...repo,
				pull_number: number,
				...update,
			});
		},
		closePr: async (repo, number, body) => {
			await comment(repo, number, body);
			await octokit.rest.pulls.update({
				...repo,
				pull_number: number,
				state: "closed",
			});
			// Closed PRs leave the pending queue; 404: label already gone.
			await removeLabel(repo, number, LABELS.pending);
		},
		setLabel: async (repo, number, { label, comment: body }) => {
			const { data: current } = await octokit.rest.issues.listLabelsOnIssue({
				...repo,
				issue_number: number,
				per_page: 100,
			});
			await Promise.all(
				current
					.filter((l) => l.name.startsWith("tallyrelease:") && l.name !== label)
					.map(async ({ name }) => {
						await removeLabel(repo, number, name);
					}),
			);

			if (!current.some((l) => l.name === label)) {
				await ensureLabel(repo, label);
				await octokit.rest.issues.addLabels({
					...repo,
					issue_number: number,
					labels: [label],
				});
			}

			if (body !== undefined) {
				await comment(repo, number, body);
			}
		},
		branchSha: async (repo, branch) =>
			(
				await unless(
					octokit.rest.git.getRef({ ...repo, ref: `heads/${branch}` }),
					404,
				)
			)?.data.object.sha,
		prForCommit: async (repo, sha) => {
			const prs = await unless(
				octokit.rest.repos.listPullRequestsAssociatedWithCommit({
					...repo,
					commit_sha: sha,
				}),
				404,
				422,
			);
			// Rebase merges record only the last rebased commit as merge commit.
			const pr =
				prs?.data.find((p) => p.merge_commit_sha === sha) ??
				prs?.data.find((p) => p.merged_at !== null);

			return (
				pr && {
					number: pr.number,
					url: pr.html_url,
					labels: pr.labels.map((l) => l.name),
				}
			);
		},
		releaseByTag: async (repo, tag) => {
			const release = await unless(
				octokit.rest.repos.getReleaseByTag({ ...repo, tag }),
				404,
			);

			return release && { id: release.data.id, url: release.data.html_url };
		},
		createRelease: async (repo, { tag, name, body, makeLatest }) => {
			const { data } = await conflict(
				octokit.rest.repos.createRelease({
					...repo,
					tag_name: tag,
					name,
					body,
					make_latest: makeLatest ? "true" : "false",
				}),
			);

			return { id: data.id, url: data.html_url };
		},
	};
};
