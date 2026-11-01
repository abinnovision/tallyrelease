import { changesetsPlugin } from "./changesets/plugin.js";
import { dartPlugin } from "./dart/plugin.js";
import { goPlugin } from "./go/plugin.js";
import { kustomizePlugin } from "./kustomize/plugin.js";
import { nodePlugin } from "./node/plugin.js";
import { phpPlugin } from "./php/plugin.js";

import type { Plugin } from "@tallyrelease/core";

export const builtinPlugins: Record<string, Plugin<any>> = {
	node: nodePlugin,
	php: phpPlugin,
	go: goPlugin,
	kustomize: kustomizePlugin,
	dart: dartPlugin,
	changesets: changesetsPlugin,
};
