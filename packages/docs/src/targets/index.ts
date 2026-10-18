import { configuration } from "./configuration.ts";
import { errors } from "./errors.ts";

import type { DocTarget } from "../runner.ts";

export const targets: DocTarget[] = [configuration, errors];
