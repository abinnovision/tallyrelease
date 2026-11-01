import { join, resolve } from "node:path";

import {
	affectedOutputs,
	planOutputs,
	releasesOutputs,
} from "../ci/outputs.js";
import { cliCodes } from "../codes.js";
import { painter } from "../output/paint.js";
import { planMarkdown, planText } from "../render/plan.js";

import type { PlanFlags } from "./setup.js";
import type { BuildBase } from "../ci/base.js";
import type { ReleaseEntry } from "../plan-schema.js";
import type { Session } from "../session.js";
import type { AffectedDoc, Plan } from "@tallyrelease/core";

/** `--out` resolved against the working directory. */
export const outPath = (session: Session, out: string | undefined) =>
	out === undefined ? undefined : resolve(session.cwd, out);

/** Pretty-printed JSON document with a trailing newline. */
export const toJson = (doc: unknown): string =>
	`${JSON.stringify(doc, null, 2)}\n`;

/** Writes the affected `doc` to `--out` and the step outputs. */
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
		session.ci.writeOutput(affectedOutputs(doc));
	}
};

/** Writes `doc` to `--out`, the step outputs, the step summary and stdout. */
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
		const { ci } = session;
		if (!ci.hasOutput) {
			throw cliCodes.error(
				"E_GITHUB_OUTPUT",
				"--github-output requires GITHUB_OUTPUT to be set",
			);
		}

		if (out === undefined && ci.outputDir === undefined) {
			throw cliCodes.error(
				"E_GITHUB_OUTPUT",
				"--github-output requires --out or RUNNER_TEMP to be set",
			);
		}

		const path = out ?? join(ci.outputDir ?? "", "tallyrelease-plan.json");
		if (out === undefined) {
			session.writeOutFile(path, json);
		}

		ci.writeOutput([
			...planOutputs(path),
			...(releases === undefined ? [] : releasesOutputs(releases)),
		]);
	}

	const appended =
		flags.summary && session.ci.writeSummary(planMarkdown(doc, base));

	const format = flags.format ?? (flags.json ? "json" : "text");
	session.stdout.write(
		format === "json"
			? json
			: flags.summary && !appended
				? planMarkdown(doc, base)
				: planText(doc, base, painter(session.stdout)),
	);
};
