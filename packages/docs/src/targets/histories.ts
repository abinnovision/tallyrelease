// Renders docs/assets/histories/<name>.json to docs/assets/<name>-<theme>.svg.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { historyStep, renderHistory } from "../gitsvg.ts";

import type { History, Theme } from "../gitsvg.ts";
import type { DocTarget } from "../runner.ts";

const dir = fileURLToPath(
	new URL("../../../../docs/assets/histories", import.meta.url),
);
const themes: Theme[] = ["light", "dark"];

const read = (file: string): History =>
	JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as History;

export const histories: DocTarget[] = readdirSync(dir)
	.filter((file) => file.endsWith(".json"))
	.sort()
	.flatMap((file) => {
		const name = file.slice(0, -".json".length);
		const views = [
			{ name, pick: (h: History) => h },
			...(read(file).steps ?? []).map((step) => ({
				name: `${name}-${step.name}`,
				pick: (h: History) => historyStep(h, step),
			})),
		];

		return views.flatMap((view) =>
			themes.map((theme) => ({
				name: `history:${view.name}:${theme}`,
				path: `docs/assets/${view.name}-${theme}.svg`,
				format: "svg" as const,
				render: () => renderHistory(view.pick(read(file)), theme),
			})),
		);
	});
