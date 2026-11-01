import { githubCi } from "./github.js";

import type { Env } from "./env.js";
import type { RepoRef } from "../forge/forge.js";

/** Event that triggered the CI run. */
export type CiEvent =
	| { kind: "pull_request"; name: string; baseSha: () => string | undefined }
	| { kind: "merge_group"; name: string; baseSha: () => string | undefined }
	| { kind: "push"; name: string; before: () => string | undefined }
	// workflow_dispatch and schedule.
	| { kind: "dispatch"; name: string }
	| { kind: "other"; name: string };

/** Inputs of the last successful run lookup. */
export interface BaseInputs {
	/** Workflow file name, for example `ci.yaml`. */
	workflow: string | undefined;
	ref: string | undefined;
	repository: RepoRef | undefined;
}

/** CI system the cli runs in. */
export interface CiProvider {
	/** Undefined without a CI event; payload getters parse lazily and once (`E_GITHUB_EVENT`). */
	readonly event: CiEvent | undefined;
	/** PR head branch, else the ref name; undefined without a CI event. */
	readonly branch: string | undefined;
	/** Undefined without a CI event. */
	readonly baseInputs: BaseInputs | undefined;
	/** The event is a pull request or merge queue event (effects do nothing); false without an event. */
	readonly prEvent: boolean;
	/** The run checks out a pull request head: a PR event or a `refs/pull/` ref. */
	readonly onPrHead: boolean;
	/** `owner/repo` as given by the CI. */
	readonly repository: string | undefined;
	/** Web URL of the repository from the CI environment. */
	readonly repoUrl: string | undefined;
}

/** CI provider of the environment; always GitHub Actions. */
export const detectCi = (env: Env): CiProvider => githubCi(env);
