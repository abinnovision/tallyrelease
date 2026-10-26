import { short } from "./short.js";
import { alignColumns } from "../output/columns.js";
import { count } from "../output/count.js";
import { unlabelled } from "../shadow/compare.js";

import type { ShadowReport, ShadowRow } from "../shadow/compare.js";

// Workflow command data escaping.
const escapeData = (value: string) =>
	value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/** Text of `shadow`: header, then the row table and a summary. */
export const shadowText = (report: ShadowReport): string => {
	const header = `shadow  ${short(report.head)} (planned ${short(report.planned)}, branch ${report.branch})`;
	if (report.skipped) {
		return `${header}\nskipped (${report.skipped.reason}): ${report.skipped.message}\n`;
	}

	const table = alignColumns([
		["PATH", "UNIT", "STATUS", "BEFORE", "AFTER", "NEXT", "LABELS"],
		...report.rows.map((r) => [
			r.path,
			r.unit ?? "-",
			r.status,
			r.before ?? "-",
			r.after ?? "-",
			r.next ?? "-",
			r.labels.join(",") || "-",
		]),
	]);
	const matched = report.rows.filter((r) => r.status === "match").length;

	return `${[
		header,
		"",
		...table,
		"",
		`${count(report.rows.length, "row")}: ${String(matched)} match, ${String(unlabelled(report.rows).length)} unlabelled`,
	].join("\n")}\n`;
};

/** Markdown of `shadow` for the step summary. */
export const shadowMarkdown = (report: ShadowReport): string => {
	const pin = report.pin === null ? "" : `, pin \`${report.pin}\``;
	const lines = [
		"### tallyrelease shadow",
		"",
		`Head \`${short(report.head)}\`, planned \`${short(report.planned)}\` on \`${report.branch}\`${pin}.`,
		"",
	];
	if (report.skipped) {
		lines.push(`Skipped (${report.skipped.reason}): ${report.skipped.message}`);
	} else {
		lines.push(
			"| Path | Unit | Status | Before | release-please | tallyrelease | Labels |",
			"| :-- | :-- | :-- | :-- | :-- | :-- | :-- |",
			...report.rows.map(
				(r) =>
					`| \`${r.path}\` | ${r.unit ?? "-"} | ${r.status} | ${r.before ?? "-"} | ${r.after ?? "-"} | ${r.next ?? "-"} | ${r.labels.join(", ") || "-"} |`,
			),
		);
	}

	return `${lines.join("\n")}\n`;
};

/** Workflow warning annotation of an unlabelled row. */
export const shadowAnnotation = (r: ShadowRow): string =>
	`::warning title=tallyrelease shadow::${escapeData(`${r.path}: ${r.status} (release-please ${r.after ?? "-"}, tallyrelease ${r.next ?? "-"})`)}\n`;
