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

/** Output of a CI step. */
export interface OutputEntry {
	key: string;
	value: string;
	/** Delimiter syntax, as for `affected-paths`. */
	multiline?: boolean;
}

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
	/** Step outputs can be written. */
	readonly hasOutput: boolean;
	/** Appends step outputs; `E_GITHUB_OUTPUT` when they cannot be written. */
	readonly writeOutput: (entries: readonly OutputEntry[]) => void;
	/** Default directory of the plan file of `--github-output`. */
	readonly outputDir: string | undefined;
	readonly hasSummary: boolean;
	/** Appends markdown to the step summary; false when there is none. */
	readonly writeSummary: (markdown: string) => boolean;
}

/** CI provider of the environment; always GitHub Actions. `appendFile` defaults to `node:fs`. */
export const detectCi = (
	env: Env,
	appendFile?: (path: string, content: string) => void,
): CiProvider => githubCi(env, appendFile);
