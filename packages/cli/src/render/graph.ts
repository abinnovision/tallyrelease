import { alignColumns } from "../output/columns.js";
import { count } from "../output/count.js";
import { renderTree } from "../output/tree.js";

import type { Paint } from "../output/paint.js";

interface GraphUnit {
	id: string;
	path: string;
	plugin: string;
	version: string;
	tags: string[];
}

/** Text of `graph`: the unit table, the dependents tree and a summary. */
export const graphText = (
	{
		units,
		edges,
		dependents,
	}: {
		units: readonly GraphUnit[];
		edges: number;
		dependents: (id: string) => readonly string[];
	},
	paint: Paint,
): string => {
	if (units.length === 0) {
		return "no units\n";
	}

	const tagged = units.some((u) => u.tags.length > 0);
	const table = [
		["UNIT", "PATH", "PLUGIN", "RELEASE", ...(tagged ? ["TAGS"] : [])],
		...units.map((u) => [
			u.id,
			u.path,
			u.plugin,
			u.version === "none" ? "-" : u.version,
			...(tagged ? [u.tags.join(",")] : []),
		]),
	];
	// Header is aligned unstyled so column styles do not apply to it.
	const [header = ""] = alignColumns(table);
	const [, ...rows] = alignColumns(
		table,
		{ styles: [undefined, "dim"] },
		paint,
	);
	const lines = [paint("bold", header), ...rows];

	const tree = renderTree(
		units.map((u) => u.id),
		dependents,
	);
	if (edges > 0) {
		lines.push("", paint("bold", "dependents"), ...tree.lines);
	}

	const released = units.filter((u) => u.version !== "none").length;
	const legend = [
		...(tree.shared ? ["(*) expanded above"] : []),
		...(tree.cycle ? ["(cycle) edge back into the current path"] : []),
	];
	lines.push(
		"",
		[
			`${count(units.length, "unit")} (${String(released)} released), ${count(edges, "edge")}`,
			...legend,
		].join("; "),
	);

	return `${lines.join("\n")}\n`;
};
