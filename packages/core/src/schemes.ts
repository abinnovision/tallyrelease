import { coreCodes } from "./codes.js";

import type { Plugin, VersionScheme } from "./plugin.js";

interface Clash {
	readonly scheme: string;
	readonly plugins: readonly [string, string];
}

const clashes = new WeakMap<ReadonlyMap<string, unknown>, Clash>();

/**
 * Name to scheme of `plugins`; the first registration of a name wins and a
 * duplicate is recorded for `assertSchemes`.
 */
export const schemeRegistry = (
	plugins: readonly Plugin[],
): ReadonlyMap<string, VersionScheme<any>> => {
	const owners = new Map<string, string>();
	const registry = new Map<string, VersionScheme<any>>();
	let clash: Clash | undefined;
	for (const plugin of plugins) {
		for (const [name, scheme] of Object.entries(plugin.schemes ?? {})) {
			const owner = owners.get(name);
			if (owner !== undefined) {
				clash ??= { scheme: name, plugins: [owner, plugin.name] };
				continue;
			}

			owners.set(name, plugin.name);
			registry.set(name, scheme);
		}
	}

	if (clash) {
		clashes.set(registry, clash);
	}

	return registry;
};

/** Throws the `E_SCHEME_CLASH` recorded by `schemeRegistry`. */
export const assertSchemes = (registry: ReadonlyMap<string, unknown>): void => {
	const clash = clashes.get(registry);
	if (clash) {
		const [first, second] = clash.plugins;
		throw coreCodes.error(
			"E_SCHEME_CLASH",
			`scheme "${clash.scheme}" is registered by "${first}" and "${second}"`,
			{ scheme: clash.scheme, plugins: [first, second] },
		);
	}
};
