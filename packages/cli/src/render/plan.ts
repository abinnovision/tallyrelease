import { baseLabel, baseLine } from "../ci/base.js";
import { alignColumns } from "../output/columns.js";
import { count } from "../output/count.js";

import type { BuildBase } from "../ci/base.js";
import type { Paint } from "../output/paint.js";
import type { Plan, PlanLine } from "@tallyrelease/core";

const lineLabel = (line: PlanLine | null, branch: string): string =>
	line === null
		? `${branch} (no branch rule)`
		: `${branch} (rule ${line.rule}, ${line.kind} line${line.channel === null ? "" : `, channel ${line.channel}`}${line.maxBump === null ? "" : `, max bump ${line.maxBump}`}${line.absolute === null ? "" : `, base ${String(line.absolute.major)}.${line.absolute.minor === undefined ? "x" : String(line.absolute.minor)} of ${line.absolute.unit ?? line.absolute.group ?? ""}`})`;

/** Text of `plan`: branch, base, then the unit table and a summary. */
export const planText = (doc: Plan, base: BuildBase, paint: Paint): string => {
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

/** Markdown of `plan` for the step summary. */
export const planMarkdown = (doc: Plan, base: BuildBase): string => {
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
