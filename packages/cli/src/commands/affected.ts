import { computeAffected, TallyError } from "@tallyrelease/core";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { baseLabel, resolveBuildBase } from "../ci/base.js";
import { affectedGithubOutput } from "../ci/outputs.js";
import { alignColumns } from "../output/columns.js";
import { count } from "../output/count.js";
import { painter } from "../output/paint.js";
import { branchName } from "../session.js";
import { version } from "../version.js";

import type { Session } from "../session.js";
import type { AffectedDoc, AffectedReason } from "@tallyrelease/core";

const GROUPS: readonly AffectedReason[] = [
	"all",
	"global",
	"direct",
	"dependent",
	"group",
];

const tsv = (doc: AffectedDoc): string =>
	[
		"id\tpath\treason\tvia\treleased\ttags",
		...doc.units.map((u) =>
			[
				u.id,
				u.path,
				u.reason,
				u.via.join(","),
				String(u.released),
				u.tags.join(","),
			].join("\t"),
		),
	]
		.map((line) => `${line}\n`)
		.join("");

export interface AffectedFlags {
	base?: string;
	format?: "text" | "json" | "tsv";
	json?: boolean;
	out?: string;
	githubOutput?: boolean;
	/** Keeps units with at least one of these tags. */
	tag?: string[];
}

/** Computes the build set and writes the requested outputs. */
export const affected = async (
	session: Session,
	flags: AffectedFlags,
): Promise<void> => {
	const { git, github } = session;
	const workspace = await session.workspace();
	const head = await git.resolve("HEAD");
	if (head === undefined) {
		throw new TallyError(
			"E_NO_HEAD",
			"HEAD does not resolve to a commit; the repository has no commits",
		);
	}

	const base = await resolveBuildBase({
		git,
		head,
		env: session.env,
		cliBase: flags.base,
		github,
		forge: session.forge,
		remote: session.remote,
	});
	const computed = await computeAffected(workspace, git, {
		tool: `tallyrelease@${version}`,
		branch: await branchName(session),
		head,
		base: base.base,
		baseSource: base.source,
	});
	const tags = new Set(flags.tag ?? []);
	const known = new Set(workspace.units.flatMap((u) => u.tags));
	const unknownTags = [...tags]
		.filter((t) => !known.has(t))
		.map((t) => ({
			code: "W_TAG_UNKNOWN",
			message: `no unit has tag "${t}"`,
		}));
	const selected = (u: { tags: readonly string[] }) =>
		tags.size === 0 || u.tags.some((t) => tags.has(t));
	const doc = {
		...computed,
		units: computed.units.filter(selected),
		warnings: [...computed.warnings, ...base.warnings, ...unknownTags],
	};
	session.warn(doc.warnings);

	const json = `${JSON.stringify(doc, null, 2)}\n`;
	if (flags.out !== undefined) {
		writeFileSync(resolve(session.cwd, flags.out), json);
	}

	if (flags.githubOutput) {
		const path = session.env["GITHUB_OUTPUT"];
		if (!path) {
			throw new TallyError(
				"E_GITHUB_OUTPUT",
				"--github-output requires GITHUB_OUTPUT to be set",
			);
		}

		appendFileSync(path, affectedGithubOutput(doc));
	}

	const format = flags.format ?? (flags.json ? "json" : "text");
	if (format === "json") {
		session.stdout.write(json);

		return;
	}

	if (format === "tsv") {
		session.stdout.write(tsv(doc));

		return;
	}

	const paint = painter(session.stdout);
	const rows = alignColumns(
		doc.units.map((u) => [
			u.id,
			u.path,
			u.via.length > 0 ? `via ${u.via.join(", ")}` : "",
			u.released ? "released" : "",
		]),
		{ indent: 2, styles: [undefined, "dim", "dim", "cyan"] },
		paint,
	);
	const sha = doc.build.base?.slice(0, 7) ?? "none";
	const lines = [
		`${paint("bold", "base")}  ${paint("yellow", sha)} ${paint("dim", `(${baseLabel(base)})`)}`,
		"",
	];
	for (const group of GROUPS) {
		const members = rows.filter((_, i) => doc.units[i]?.reason === group);
		if (members.length > 0) {
			lines.push(paint("bold", `${group} (${String(members.length)})`));
			if (group === "global") {
				lines.push(`  changed: ${doc.build.globalInputs.join(", ")}`);
			}

			lines.push(...members);
		}
	}

	if (doc.units.length > 0) {
		lines.push("");
	}

	const outside =
		doc.unattributed.length > 0
			? `, ${count(doc.unattributed.length, "file")} outside any unit`
			: "";
	lines.push(
		doc.units.length > 0
			? `${String(doc.units.length)} of ${count(workspace.units.filter(selected).length, "unit")} affected${outside}`
			: `no units affected${outside}`,
	);
	session.stdout.write(`${lines.join("\n")}\n`);
};
