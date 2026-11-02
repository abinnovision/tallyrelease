import { cli } from "./cli.ts";
import { configuration } from "./configuration.ts";
import { errors } from "./errors.ts";
import { histories } from "./histories.ts";
import { releaseList } from "./release-list.ts";

import type { DocTarget } from "../runner.ts";

export const targets: DocTarget[] = [
	configuration,
	errors,
	cli,
	releaseList,
	...histories,
];
