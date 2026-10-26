import { short } from "./short.js";
import { baseLabel } from "../ci/base.js";
import { alignColumns } from "../output/columns.js";
import { count } from "../output/count.js";

import type { BuildBase } from "../ci/base.js";
import type { Paint } from "../output/paint.js";
import type { AffectedDoc, AffectedReason } from "@tallyrelease/core";

const GROUPS: readonly AffectedReason[] = [
	"all",
	"global",
	"direct",
	"dependent",
	"group",
];

/** Tab-separated units of `affected` with a header row. */
export const affectedTsv = (doc: AffectedDoc): string =>
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

/** Text of `affected`: units grouped by reason; `total` counts the selectable units. */
export const affectedText = (
	{ doc, base, total }: { doc: AffectedDoc; base: BuildBase; total: number },
	paint: Paint,
): string => {
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
	const sha = short(doc.build.base, "none");
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
			? `${String(doc.units.length)} of ${count(total, "unit")} affected${outside}`
			: `no units affected${outside}`,
	);

	return `${lines.join("\n")}\n`;
};
