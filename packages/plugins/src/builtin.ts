import { kustomizePlugin } from "./kustomize/plugin.js";
import { nodePlugin } from "./node/plugin.js";
import { phpPlugin } from "./php/plugin.js";

import type { Plugin } from "@tallyrelease/core";

export const builtinPlugins: Record<string, Plugin<any>> = {
	node: nodePlugin,
	php: phpPlugin,
	kustomize: kustomizePlugin,
};
