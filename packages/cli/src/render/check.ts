import { count } from "../output/count.js";

/** Output of `check`: unit and edge counts and the released units. */
export const checkText = ({
	units,
	released,
	edges,
}: {
	units: number;
	released: readonly string[];
	edges: number;
}): string => {
	const list = released.length > 0 ? `: ${released.join(", ")}` : "";

	return `ok: ${count(units, "unit")} (${String(released.length)} released${list}), ${count(edges, "edge")}\n`;
};
