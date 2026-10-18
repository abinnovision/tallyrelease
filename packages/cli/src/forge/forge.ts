export interface RepoRef {
	owner: string;
	repo: string;
}

export interface WorkflowRunQuery extends RepoRef {
	/** Workflow file name, for example `ci.yaml`. */
	workflow: string;
	branch: string;
	/** 1-based page of runs, defaults to 1. */
	page?: number;
}

/** Labels of release PRs; `setLabel` keeps one of them per PR. */
export const LABELS = {
	pending: "tallyrelease: pending",
	released: "tallyrelease: released",
	stale: "tallyrelease: stale",
} as const;

export interface ReleasePr {
	number: number;
	/** Web URL. */
	url: string;
	/** Head branch name. */
	head: string;
	headSha: string;
	base: string;
	body: string;
	labels: string[];
	/** Null unless merged. */
	mergedAt: string | null;
	mergeCommitSha: string | null;
}

export interface ReleasePrQuery {
	/** Base branch. */
	base: string;
	/** Open PRs by number, or merged PRs oldest merge first. */
	state: "open" | "merged";
}

export interface NewPr {
	head: string;
	base: string;
	title: string;
	body: string;
}

export interface NewRelease {
	tag: string;
	name: string;
	body: string;
	makeLatest: boolean;
}

/** Code host API used by the cli. */
export interface Forge {
	/** Head shas of successful push runs of a workflow on a branch, newest first; empty past the last page. */
	lastSuccessfulPushRuns: (query: WorkflowRunQuery) => Promise<string[]>;
	/** PRs labelled `tallyrelease: pending` on a base branch, from heads in this repository. */
	releasePrs: (repo: RepoRef, query: ReleasePrQuery) => Promise<ReleasePr[]>;
	/** Open PR from `head` in this repository into `base`, whatever its labels. */
	openPr: (
		repo: RepoRef,
		query: { head: string; base: string },
	) => Promise<ReleasePr | undefined>;
	/** Returns the PR number. */
	createPr: (repo: RepoRef, pr: NewPr) => Promise<number>;
	updatePr: (
		repo: RepoRef,
		number: number,
		update: { title?: string; body?: string },
	) => Promise<void>;
	closePr: (repo: RepoRef, number: number, comment: string) => Promise<void>;
	/** Sets `label`, removes the other `tallyrelease:` labels, creates missing labels. */
	setLabel: (
		repo: RepoRef,
		number: number,
		update: { label: string; comment?: string },
	) => Promise<void>;
	/** Undefined when the branch does not exist. */
	branchSha: (repo: RepoRef, branch: string) => Promise<string | undefined>;
	/** PR that merged `sha`, undefined if none. */
	prForCommit: (
		repo: RepoRef,
		sha: string,
	) => Promise<{ number: number; url: string; labels: string[] } | undefined>;
	/** Undefined when no release exists for the tag. */
	releaseByTag: (
		repo: RepoRef,
		tag: string,
	) => Promise<{ id: number; url: string } | undefined>;
	/** Release for an existing tag. */
	createRelease: (
		repo: RepoRef,
		release: NewRelease,
	) => Promise<{ id: number; url: string }>;
}
