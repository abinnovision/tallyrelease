import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

import { cliCodes } from "../codes.js";

import type { Env } from "./env.js";
import type { CiEvent, CiProvider, OutputEntry } from "./provider.js";

const nonEmpty = (value: string | undefined) =>
	value === "" ? undefined : value;

const str = (value: unknown): string | undefined =>
	typeof value === "string" && value !== "" ? value : undefined;

const field = (value: unknown, key: string): unknown =>
	typeof value === "object" && value !== null
		? (value as Record<string, unknown>)[key]
		: undefined;

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

/** Events that run on a pull request head or a merge queue commit. */
const PR_EVENTS: ReadonlySet<string> = new Set([
	"pull_request",
	"pull_request_target",
	"merge_group",
]);

/** `$GITHUB_OUTPUT` line of `entry`. */
const outputLine = ({ key, value, multiline }: OutputEntry): string => {
	if (!multiline) {
		return `${key}=${value}\n`;
	}

	const delimiter = `ghadelimiter_${randomUUID()}`;

	return `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
};

/** `CiEvent` of `name`; `payload` is the parsed `GITHUB_EVENT_PATH`. */
const ciEvent = (
	name: string,
	payload: () => Record<string, unknown>,
): CiEvent => {
	switch (name) {
		case "pull_request":
			return {
				kind: name,
				name,
				baseSha: () =>
					str(field(field(payload()["pull_request"], "base"), "sha")),
			};
		case "merge_group":
			return {
				kind: name,
				name,
				baseSha: () => str(field(payload()["merge_group"], "base_sha")),
			};
		case "push":
			return { kind: name, name, before: () => str(payload()["before"]) };
		case "workflow_dispatch":
		case "schedule":
			return { kind: "dispatch", name };
		default:
			return { kind: "other", name };
	}
};

/** GitHub Actions run context from `GITHUB_*` variables. */
export const githubCi = (
	env: Env,
	appendFile: (path: string, content: string) => void = appendFileSync,
): CiProvider => {
	const eventName = nonEmpty(env["GITHUB_EVENT_NAME"]);
	const eventPath = env["GITHUB_EVENT_PATH"];
	let payload: Record<string, unknown> | undefined;

	// owner/repo/.github/workflows/ci.yaml@refs/heads/main
	const workflowPath = env["GITHUB_WORKFLOW_REF"]?.split("@")[0];
	const repository = env["GITHUB_REPOSITORY"];
	const [owner, repo] = repository?.split("/") ?? [];
	const refName = nonEmpty(env["GITHUB_REF_NAME"]);
	const server = env["GITHUB_SERVER_URL"];
	const prEvent = eventName !== undefined && PR_EVENTS.has(eventName);
	const output = env["GITHUB_OUTPUT"];
	const summary = env["GITHUB_STEP_SUMMARY"];

	return {
		event:
			eventName === undefined
				? undefined
				: ciEvent(
						eventName,
						() => (payload ??= eventPath ? parseEvent(eventPath) : {}),
					),
		branch:
			eventName === undefined
				? undefined
				: (nonEmpty(env["GITHUB_HEAD_REF"]) ?? refName),
		baseInputs:
			eventName !== undefined
				? {
						workflow: nonEmpty(workflowPath?.split("/").at(-1)),
						ref: refName,
						repository: owner && repo ? { owner, repo } : undefined,
					}
				: undefined,
		prEvent,
		onPrHead: prEvent || env["GITHUB_REF"]?.startsWith("refs/pull/") === true,
		repository,
		repoUrl:
			server && repository
				? `${server.replace(/\/+$/, "")}/${repository}`
				: undefined,
		hasOutput: Boolean(output),
		writeOutput: (entries) => {
			if (!output) {
				throw cliCodes.error(
					"E_GITHUB_OUTPUT",
					"--github-output requires GITHUB_OUTPUT to be set",
				);
			}

			appendFile(output, entries.map(outputLine).join(""));
		},
		outputDir: nonEmpty(env["RUNNER_TEMP"]),
		hasSummary: Boolean(summary),
		writeSummary: (markdown) => {
			if (!summary) {
				return false;
			}

			appendFile(summary, markdown);

			return true;
		},
	};
};
