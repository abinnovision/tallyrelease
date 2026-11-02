// Renders docs/assets/histories/<name>.json to docs/assets/<name>-<theme>.svg.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderHistory } from "../gitsvg.ts";

import type { History, Theme } from "../gitsvg.ts";
import type { DocTarget } from "../runner.ts";

const dir = fileURLToPath(
	new URL("../../../../docs/assets/histories", import.meta.url),
);
const themes: Theme[] = ["light", "dark"];

export const histories: DocTarget[] = readdirSync(dir)
	.filter((file) => file.endsWith(".json"))
	.sort()
	.flatMap((file) => {
		const name = file.slice(0, -".json".length);

		return themes.map((theme) => ({
			name: `history:${name}:${theme}`,
			path: `docs/assets/${name}-${theme}.svg`,
			format: "svg" as const,
			render: () =>
				renderHistory(
					JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as History,
					theme,
				),
		}));
	});
