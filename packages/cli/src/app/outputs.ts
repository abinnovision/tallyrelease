import { join, resolve } from "node:path";

import {
	affectedGithubOutput,
	planGithubOutput,
	releasesGithubOutput,
} from "../ci/outputs.js";
import { appendStepSummary } from "../ci/summary.js";
import { cliCodes } from "../codes.js";
import { painter } from "../output/paint.js";
import { planMarkdown, planText } from "../render/plan.js";

import type { PlanFlags } from "./setup.js";
import type { BuildBase } from "../ci/base.js";
import type { ReleaseEntry } from "../plan-schema.js";
import type { Session } from "../session.js";
import type { AffectedDoc, Plan } from "@tallyrelease/core";

/** `--out` resolved against the working directory. */
const outPath = (session: Session, out: string | undefined) =>
	out === undefined ? undefined : resolve(session.cwd, out);

/** `$GITHUB_OUTPUT`; `E_GITHUB_OUTPUT` when it is not set. */
const githubOutputPath = (session: Session): string => {
	const path = session.env["GITHUB_OUTPUT"];
	if (!path) {
		throw cliCodes.error(
			"E_GITHUB_OUTPUT",
			"--github-output requires GITHUB_OUTPUT to be set",
		);
	}

	return path;
};

/** Pretty-printed JSON document with a trailing newline. */
export const toJson = (doc: unknown): string =>
	`${JSON.stringify(doc, null, 2)}\n`;

/** Writes the affected `doc` to `--out` and `$GITHUB_OUTPUT`. */
export const writeAffected = (
	session: Session,
	doc: AffectedDoc,
	flags: { out?: string; githubOutput?: boolean },
): void => {
	const out = outPath(session, flags.out);
	if (out !== undefined) {
		session.writeOutFile(out, toJson(doc));
	}

	if (flags.githubOutput) {
		session.appendFile(githubOutputPath(session), affectedGithubOutput(doc));
	}
};

/** Writes `doc` to `--out`, `$GITHUB_OUTPUT`, the step summary and stdout. */
export const writePlan = (
	session: Session,
	{
		doc,
		base,
		releases,
	}: { doc: Plan; base: BuildBase; releases?: readonly ReleaseEntry[] },
	flags: Pick<
		PlanFlags,
		"format" | "json" | "out" | "githubOutput" | "summary"
	>,
): void => {
	const json = toJson(doc);
	const out = outPath(session, flags.out);
	if (out !== undefined) {
		session.writeOutFile(out, json);
	}

	if (flags.githubOutput) {
		const outputPath = githubOutputPath(session);

		const temp = session.env["RUNNER_TEMP"];
		if (out === undefined && !temp) {
			throw cliCodes.error(
				"E_GITHUB_OUTPUT",
				"--github-output requires --out or RUNNER_TEMP to be set",
			);
		}

		const path = out ?? join(temp ?? "", "tallyrelease-plan.json");
		if (out === undefined) {
			session.writeOutFile(path, json);
		}

		session.appendFile(
			outputPath,
			planGithubOutput(path) +
				(releases === undefined ? "" : releasesGithubOutput(releases)),
		);
	}

	const appended =
		flags.summary && appendStepSummary(session, planMarkdown(doc, base));

	const format = flags.format ?? (flags.json ? "json" : "text");
	session.stdout.write(
		format === "json"
			? json
			: flags.summary && !appended
				? planMarkdown(doc, base)
				: planText(doc, base, painter(session.stdout)),
	);
};
