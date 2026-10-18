import { corePlugin } from "./builtin.js";
import { coreCodes } from "./codes.js";

import type { Plugin, VersionScheme } from "./plugin.js";

export interface SchemeEntry {
	readonly plugin: string;
	readonly name: string;
	readonly scheme: VersionScheme<any>;
}

/** Schemes of core and the given plugins, in that order. */
export const collectSchemes = (
	active: readonly { readonly plugin: Plugin }[],
): SchemeEntry[] =>
	[corePlugin, ...active.map((a) => a.plugin)].flatMap((plugin) =>
		Object.entries(plugin.schemes ?? {}).map(([name, scheme]) => ({
			plugin: plugin.name,
			name,
			scheme,
		})),
	);

/** Name to scheme; throws `E_SCHEME_CLASH` on a duplicate name. */
export const schemeRegistry = (
	list: readonly SchemeEntry[],
): ReadonlyMap<string, VersionScheme<any>> => {
	const owners = new Map<string, string>();
	const registry = new Map<string, VersionScheme<any>>();
	for (const { plugin, name, scheme } of list) {
		const owner = owners.get(name);
		if (owner !== undefined) {
			throw coreCodes.error(
				"E_SCHEME_CLASH",
				`scheme "${name}" is registered by "${owner}" and "${plugin}"`,
				{ scheme: name, plugins: [owner, plugin] },
			);
		}

		owners.set(name, plugin);
		registry.set(name, scheme);
	}

	return registry;
};
