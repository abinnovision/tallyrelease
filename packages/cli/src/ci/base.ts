import { cliCodes } from "../codes.js";

import type { Env, GithubContext } from "./github-env.js";
import type { Forge } from "../forge/forge.js";
import type { RepoGit } from "../git/reader.js";
import type { Paint } from "../output/paint.js";
import type { BaseSource, Warning } from "@tallyrelease/core";

const ZERO_SHA = /^0+$/;

const CI_VARS = [
	"JENKINS_URL",
	"TF_BUILD",
	"CODEBUILD_BUILD_ID",
	"BUILDKITE",
	"GITLAB_CI",
	"TEAMCITY_VERSION",
	"BITBUCKET_BUILD_NUMBER",
];

/** Pages of workflow runs searched for a usable last success. */
const RUN_PAGES = 5;

const DEFAULT_BRANCHES = ["main", "master"];

const isCi = (env: Env): boolean => {
	const ci = env["CI"];

	return (
		(ci !== undefined && !["", "false", "0"].includes(ci)) ||
		CI_VARS.some((name) => env[name] !== undefined)
	);
};

const str = (value: unknown): string | undefined =>
	typeof value === "string" && value !== "" ? value : undefined;

const field = (value: unknown, key: string): unknown =>
	typeof value === "object" && value !== null
		? (value as Record<string, unknown>)[key]
		: undefined;

const noForge: Warning = cliCodes.warning(
	"W_NO_FORGE",
	"no token for the forge; the last successful run is unknown",
);

const noWorkflowContext: Warning = cliCodes.warning(
	"W_NO_WORKFLOW_CONTEXT",
	"GITHUB_REPOSITORY, GITHUB_WORKFLOW_REF or GITHUB_REF_NAME is missing; the last successful run is unknown",
);

const forgeError = (error: unknown): Warning => {
	const status = (error as { status?: unknown } | null)?.status;
	const reason = error instanceof Error ? error.message : String(error);

	return cliCodes.warning(
		"W_FORGE_ERROR",
		`forge request failed${typeof status === "number" ? ` (${String(status)})` : ""}: ${reason}; the last successful run is unknown`,
	);
};

const noLastSuccess: Warning = cliCodes.warning(
	"W_NO_LAST_SUCCESS",
	"no successful push run of this workflow on this branch",
);

export interface BuildBase {
	base: string | null;
	source: BaseSource;
	/** The `--base` value, or the branch of a local merge base. */
	ref?: string;
	warnings: Warning[];
}

export interface BuildBaseInput {
	git: RepoGit;
	env: Env;
	/** Resolved HEAD sha. */
	head: string;
	/** `--base`. */
	cliBase?: string | undefined;
	github?: GithubContext | undefined;
	/** Present only when a token is available. */
	forge?: Forge | undefined;
	/** Remote of the default branch candidates; defaults to `origin`. */
	remote?: string | undefined;
}

/** Resolves the build base from `--base`, the CI event, the forge, then the local default branch. */
export const resolveBuildBase = async (
	input: BuildBaseInput,
): Promise<BuildBase> => {
	const { git, head, github, forge } = input;

	// A named sha missing from a shallow clone must not silently become "everything".
	const local = async (ref: string, what: string) => {
		const sha = await git.resolve(ref);
		if (sha === undefined && (await git.isShallow())) {
			throw cliCodes.error(
				"E_SHALLOW_BASE",
				`${what} "${ref}" is missing in this shallow clone; fetch with fetch-depth: 0`,
				{ ref },
			);
		}

		return sha;
	};

	const required = async (ref: string | undefined, what: string) => {
		const sha = ref === undefined ? undefined : await local(ref, what);
		if (sha === undefined) {
			throw cliCodes.error(
				"E_BASE_UNRESOLVED",
				`${what} "${ref ?? ""}" does not resolve to a commit`,
				{ ref },
			);
		}

		return sha;
	};

	// A named sha that is not an ancestor may only be cut off by a shallow clone.
	const shallowBase = async (ref: string, what: string) => {
		if (await git.isShallow()) {
			throw cliCodes.error(
				"E_SHALLOW_BASE",
				`${what} "${ref}" has no history in common with HEAD in this shallow clone; fetch with fetch-depth: 0`,
				{ ref },
			);
		}
	};

	/** The newest usable successful run, or the warning why there is none. */
	const lastSuccess = async (from: Forge): Promise<string | Warning> => {
		if (!github?.repository || !github.workflow || !github.refName) {
			return noWorkflowContext;
		}

		for (let page = 1; page <= RUN_PAGES; page++) {
			let shas: string[];
			try {
				// eslint-disable-next-line no-await-in-loop -- older pages only while no run is usable
				shas = await from.lastSuccessfulPushRuns({
					...github.repository,
					workflow: github.workflow,
					branch: github.refName,
					page,
				});
			} catch (error) {
				return forgeError(error);
			}

			if (shas.length === 0) {
				break;
			}

			for (const candidate of shas) {
				// eslint-disable-next-line no-await-in-loop -- newest usable run wins
				const sha = await local(candidate, "last successful run");
				// eslint-disable-next-line no-await-in-loop -- newest usable run wins
				if (sha !== undefined && (await git.isAncestor(sha, head))) {
					return sha;
				}
			}
		}

		return noLastSuccess;
	};

	const result = (
		base: string | null,
		source: BaseSource,
		...warnings: Warning[]
	): BuildBase => ({ base, source, warnings });

	const fromLastSuccess = async (): Promise<BuildBase> => {
		if (!forge) {
			return result(null, "none", noForge);
		}

		const last = await lastSuccess(forge);

		return typeof last === "string"
			? result(last, "forge-last-success")
			: result(null, "none", last);
	};

	/** First of `<remote>/HEAD` and the common default branch names that resolves. */
	const defaultRef = async () => {
		const remote = input.remote ?? "origin";
		const candidates = [
			await git.defaultBranch(),
			...DEFAULT_BRANCHES.map((b) => `${remote}/${b}`),
			...DEFAULT_BRANCHES,
		];
		for (const candidate of candidates) {
			if (candidate === undefined) {
				continue;
			}

			// eslint-disable-next-line no-await-in-loop -- first match wins
			if ((await git.resolve(candidate)) !== undefined) {
				return candidate;
			}
		}

		return undefined;
	};

	if (input.cliBase !== undefined) {
		return {
			...result(await required(input.cliBase, "--base"), "cli"),
			ref: input.cliBase,
		};
	}

	if (github === undefined && !isCi(input.env)) {
		const ref = await defaultRef();
		const base = ref === undefined ? undefined : await git.mergeBase(head, ref);

		return ref === undefined || base === undefined
			? result(null, "none")
			: { ...result(base, "local-merge-base"), ref };
	}

	switch (github?.eventName) {
		case "pull_request": {
			const target = await required(
				str(field(field(github.payload()["pull_request"], "base"), "sha")),
				"pull_request.base.sha",
			);
			const base = await git.mergeBase(head, target);
			if (base === undefined) {
				await shallowBase(target, "pull_request.base.sha");
				throw cliCodes.error(
					"E_BASE_UNRESOLVED",
					`no merge base of HEAD and "${target}"`,
					{ ref: target },
				);
			}

			return result(base, "pr-merge-base");
		}

		case "merge_group":
			return result(
				await required(
					str(field(github.payload()["merge_group"], "base_sha")),
					"merge_group.base_sha",
				),
				"merge-group",
			);
		case "push": {
			const ref = str(github.payload()["before"]);
			const before =
				ref === undefined || ZERO_SHA.test(ref)
					? undefined
					: await local(ref, "push before");
			if (before !== undefined && (await git.isAncestor(before, head))) {
				if (!forge) {
					return result(before, "push-before", noForge);
				}

				const last = await lastSuccess(forge);
				if (typeof last !== "string") {
					return result(before, "push-before", last);
				}

				return (await git.isAncestor(last, before))
					? result(last, "forge-last-success")
					: result(before, "push-before");
			}

			if (before !== undefined) {
				await shallowBase(before, "push before");
			}

			return await fromLastSuccess();
		}

		case "workflow_dispatch":
		case "schedule":
			return await fromLastSuccess();
		default:
			return result(null, "none");
	}
};

/** Short description of where the build base came from. */
export const baseLabel = (base: BuildBase): string => {
	switch (base.source) {
		case "cli":
			return `--base ${base.ref ?? ""}`;
		case "push-before":
			return "push before";
		case "pr-merge-base":
			return "merge base with the PR target";
		case "merge-group":
			return "merge group base";
		case "forge-last-success":
			return "last successful run";
		case "local-merge-base":
			return `merge base with ${base.ref ?? ""}`;
		case "none":
			return "everything is affected";
	}
};

/** `base` line of the `plan` and `explain` text. */
export const baseLine = (paint: Paint, base: BuildBase): string =>
	`${paint("bold", "base")}    ${paint("yellow", base.base?.slice(0, 7) ?? "none")} ${paint("dim", `(${baseLabel(base)})`)}`;
