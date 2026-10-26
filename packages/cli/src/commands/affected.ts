import { computeAffected } from "@tallyrelease/core";

import { toJson, writeAffected } from "../app/outputs.js";
import { baseLabel, resolveBuildBase } from "../ci/base.js";
import { cliCodes } from "../codes.js";
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
		throw cliCodes.error(
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
		.map((t) => cliCodes.warning("W_TAG_UNKNOWN", `no unit has tag "${t}"`));
	const selected = (u: { tags: readonly string[] }) =>
		tags.size === 0 || u.tags.some((t) => tags.has(t));
	const doc = {
		...computed,
		units: computed.units.filter(selected),
		warnings: [...computed.warnings, ...base.warnings, ...unknownTags],
	};
	session.warn(doc.warnings);

	writeAffected(session, doc, flags);

	const format = flags.format ?? (flags.json ? "json" : "text");
	if (format === "json") {
		session.stdout.write(toJson(doc));

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
