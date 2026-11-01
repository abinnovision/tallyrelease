import { calver } from "./calver.js";
import { conventionalCommits } from "./conventional.js";
import { PLUGIN_API_VERSION } from "./plugin.js";
import { semver } from "./semver.js";

import type { Plugin } from "./plugin.js";

/** Plugin name reserved for core built-ins. */
export const CORE_PLUGIN = "core";

/** Core built-ins, registered before every configured plugin. */
export const corePlugin: Plugin = {
	apiVersion: PLUGIN_API_VERSION,
	name: CORE_PLUGIN,
	schemes: { semver, calver },
	intent: [conventionalCommits],
};
