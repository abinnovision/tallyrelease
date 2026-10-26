import { join, resolve } from "node:path";

import { baseLabel, baseLine } from "../ci/base.js";
import {
	affectedGithubOutput,
	planGithubOutput,
	releasesGithubOutput,
} from "../ci/outputs.js";
import { appendStepSummary } from "../ci/summary.js";
import { cliCodes } from "../codes.js";
import { alignColumns } from "../output/columns.js";
import { count } from "../output/count.js";
import { painter } from "../output/paint.js";

import type { PlanFlags } from "./setup.js";
import type { BuildBase } from "../ci/base.js";
import type { ReleaseEntry } from "../plan-schema.js";
import type { Session } from "../session.js";
import type { AffectedDoc, Plan, PlanLine } from "@tallyrelease/core";

const lineLabel = (line: PlanLine | null, branch: string): string =>
	line === null
		? `${branch} (no branch rule)`
		: `${branch} (rule ${line.rule}, ${line.kind} line${line.channel === null ? "" : `, channel ${line.channel}`}${line.maxBump === null ? "" : `, max bump ${line.maxBump}`}${line.absolute === null ? "" : `, base ${String(line.absolute.major)}.${line.absolute.minor === undefined ? "x" : String(line.absolute.minor)} of ${line.absolute.unit ?? line.absolute.group ?? ""}`})`;

const text = (session: Session, doc: Plan, base: BuildBase): string => {
	const paint = painter(session.stdout);
	const lines = [
		`${paint("bold", "branch")}  ${lineLabel(doc.line, doc.branch)}`,
		baseLine(paint, base),
		"",
	];
	if (doc.units.length === 0) {
		lines.push("no units planned");

		return `${lines.join("\n")}\n`;
	}

	const grouped = doc.units.some((u) => u.group !== null);
	const table = [
		[
			"UNIT",
			...(grouped ? ["GROUP"] : []),
			"KIND",
			"FROM",
			"BUMP",
			"NEXT",
			"VERSION",
		],
		...doc.units.map((u) => [
			u.id,
			...(grouped ? [u.group ?? "-"] : []),
			u.kind,
			u.from ?? "-",
			u.bump ?? "-",
			u.next ?? "-",
			u.version ?? "-",
		]),
	];
	// Header is aligned unstyled so column styles do not apply to it.
	const [header = ""] = alignColumns(table);
	const [, ...rows] = alignColumns(
		table,
		{ styles: grouped ? [undefined, "dim", "cyan"] : [undefined, "cyan"] },
		paint,
	);
	const kinds = (["prerelease", "rebuild", "none"] as const)
		.map((kind) => [kind, doc.units.filter((u) => u.kind === kind).length])
		.filter(([, n]) => n !== 0)
		.map(([kind, n]) => `${String(n)} ${String(kind)}`);
	lines.push(
		paint("bold", header),
		...rows,
		"",
		`${count(doc.units.length, "unit")} planned: ${kinds.join(", ")}`,
	);

	return `${lines.join("\n")}\n`;
};

const markdown = (doc: Plan, base: BuildBase): string => {
	const lines = [
		"### tallyrelease plan",
		"",
		`Branch ${lineLabel(doc.line, doc.branch)}.`,
		"",
		`Base ${base.base?.slice(0, 7) ?? "none"} (${baseLabel(base)}).`,
		"",
	];
	if (doc.units.length === 0) {
		lines.push("No units planned.");
	} else {
		const grouped = doc.units.some((u) => u.group !== null);
		lines.push(
			`| Unit |${grouped ? " Group |" : ""} Kind | From | Bump | Next | Version |`,
			`| :-- |${grouped ? " :-- |" : ""} :-- | :-- | :-- | :-- | :-- |`,
			...doc.units.map(
				(u) =>
					`| ${u.id} |${grouped ? ` ${u.group ?? "-"} |` : ""} ${u.kind} | ${u.from ?? "-"} | ${u.bump ?? "-"} | ${u.next ?? "-"} | ${u.version ?? "-"} |`,
			),
		);
	}

	if (doc.warnings.length > 0) {
		lines.push(
			"",
			"Warnings:",
			"",
			...doc.warnings.map((w) => `- ${w.code}: ${w.message}`),
		);
	}

	return `${lines.join("\n")}\n`;
};

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
		flags.summary && appendStepSummary(session, markdown(doc, base));

	const format = flags.format ?? (flags.json ? "json" : "text");
	session.stdout.write(
		format === "json"
			? json
			: flags.summary && !appended
				? markdown(doc, base)
				: text(session, doc, base),
	);
};
