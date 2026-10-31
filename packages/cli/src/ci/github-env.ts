import { readFileSync } from "node:fs";

import { cliCodes } from "../codes.js";

const nonEmpty = (value: string | undefined) =>
	value === "" ? undefined : value;

const parseEvent = (path: string): Record<string, unknown> => {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch (error) {
		throw cliCodes.error(
			"E_GITHUB_EVENT",
			`cannot read GITHUB_EVENT_PATH "${path}": ${error instanceof Error ? error.message : String(error)}`,
			{ path },
		);
	}
};

export type Env = Readonly<Record<string, string | undefined>>;

/** Events that run on a pull request head or a merge queue commit. */
export const PR_EVENTS: ReadonlySet<string> = new Set([
	"pull_request",
	"pull_request_target",
	"merge_group",
]);

/** GitHub Actions run context from `GITHUB_*` variables. */
export interface GithubContext {
	eventName: string;
	/** Parsed `GITHUB_EVENT_PATH` (read on first call), empty when unset. */
	payload: () => Record<string, unknown>;
	refName: string | undefined;
	/** Head branch of a pull request run. */
	headRef: string | undefined;
	/** Workflow file name from `GITHUB_WORKFLOW_REF`. */
	workflow: string | undefined;
	repository: { owner: string; repo: string } | undefined;
	apiUrl: string | undefined;
}

/** Undefined outside GitHub Actions (no `GITHUB_EVENT_NAME`). */
export const githubContext = (env: Env): GithubContext | undefined => {
	const eventName = env["GITHUB_EVENT_NAME"];
	if (!eventName) {
		return undefined;
	}

	const eventPath = env["GITHUB_EVENT_PATH"];
	let payload: Record<string, unknown> | undefined;

	// owner/repo/.github/workflows/ci.yaml@refs/heads/main
	const workflowPath = env["GITHUB_WORKFLOW_REF"]?.split("@")[0];
	const [owner, repo] = env["GITHUB_REPOSITORY"]?.split("/") ?? [];

	return {
		eventName,
		payload: () => (payload ??= eventPath ? parseEvent(eventPath) : {}),
		refName: nonEmpty(env["GITHUB_REF_NAME"]),
		headRef: nonEmpty(env["GITHUB_HEAD_REF"]),
		workflow: nonEmpty(workflowPath?.split("/").at(-1)),
		repository: owner && repo ? { owner, repo } : undefined,
		apiUrl: nonEmpty(env["GITHUB_API_URL"]),
	};
};
