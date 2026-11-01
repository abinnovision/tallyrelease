import { builtinPlugins } from "@tallyrelease/plugins";
import { createJiti } from "jiti";
import { join, posix } from "node:path";

import { cliCodes } from "../codes.js";

import type { CliConfig, PluginEntry } from "./schema.js";
import type { Env } from "../ci/env.js";
import type { Plugin, TallyConfig } from "@tallyrelease/core";
import type { Jiti } from "jiti";

/** Loads the plugin of `entry.path`, else of `entry.package`. */
const loadPlugin = async (
	name: string,
	{ path, package: pkg }: PluginEntry,
	{ importPlugin, localDenied }: ResolveOptions,
): Promise<Plugin> => {
	const source = path ?? pkg ?? "";
	const fail = (reason: string, error?: unknown) =>
		cliCodes.error("E_PLUGIN_LOAD", `plugin "${name}": ${reason}`, {
			plugin: name,
			source,
			...(error !== undefined && { error }),
		});

	if (Object.hasOwn(builtinPlugins, name)) {
		throw fail(
			`a built-in plugin cannot set ${path === undefined ? "package" : "path"}`,
		);
	}

	let specifier = source;
	if (path !== undefined) {
		if (localDenied !== undefined) {
			throw cliCodes.error(
				"E_PLUGIN_LOCAL",
				`plugin "${name}": ${localDenied}`,
				{ plugin: name, source },
			);
		}

		const file = posix.normalize(path);
		if (posix.isAbsolute(file) || file === ".." || file.startsWith("../")) {
			throw fail(`"${path}" is outside the repository root`);
		}

		specifier = `./${file}`;
	}

	let loaded: unknown;
	try {
		loaded = await importPlugin(specifier);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw fail(`cannot load "${source}": ${reason}`, error);
	}

	const exported =
		typeof loaded === "object" && loaded !== null
			? (loaded as { name?: unknown }).name
			: undefined;
	if (exported !== name) {
		throw fail(`"${source}" does not export a plugin named "${name}"`);
	}

	return loaded as Plugin;
};

/** Imports a module resolved from the repo root and returns its default export. */
export type ImportPlugin = (specifier: string) => Promise<unknown>;

/**
 * `ImportPlugin` with jiti, so `.ts` files load without a build step. No disk
 * cache, so transpiled code cannot be planted between runs.
 */
export const jitiImport = (root: string): ImportPlugin => {
	let jiti: Jiti | undefined;

	return async (specifier) => {
		jiti ??= createJiti(join(root, "/"), { fsCache: false });

		return await jiti.import(specifier, { default: true });
	};
};

/**
 * Why a privileged command may not load local plugins, undefined when it may:
 * never on a pull request head, else only when allowed by flag or env.
 */
export const localPluginsDenied = (
	onPrHead: boolean,
	env: Env,
	allowFlag: boolean,
): string | undefined => {
	if (onPrHead) {
		return "privileged commands never load local plugins on a pull request head";
	}

	const allowEnv = env["TALLYRELEASE_ALLOW_LOCAL_PLUGINS"] ?? "";

	return allowFlag || /^(?:1|true)$/i.test(allowEnv)
		? undefined
		: "privileged commands load local plugins only with --allow-local-plugins or TALLYRELEASE_ALLOW_LOCAL_PLUGINS=true";
};

export interface ResolveOptions {
	importPlugin: ImportPlugin;
	/** Why local plugins (`path`) may not load; undefined when they may. */
	localDenied?: string | undefined;
}

export interface ResolvedPlugins {
	/** The config without cli-owned plugin keys, as core reads it. */
	config: TallyConfig;
	/** Built-in plugins, then loaded plugins in config order. */
	plugins: Plugin[];
}

/**
 * Resolves `config.plugins` to plugins: a built-in by name, else the file at
 * `path`, else the package `package`. Core checks the API version and
 * validates the options.
 */
export const resolvePlugins = async (
	config: CliConfig,
	opts: ResolveOptions,
): Promise<ResolvedPlugins> => {
	const plugins: Plugin[] = Object.values(builtinPlugins);
	const entries: TallyConfig["plugins"] = {};
	for (const [name, entry] of Object.entries(config.plugins)) {
		const { path, package: pkg, ...options } = entry ?? {};
		entries[name] = entry && options;
		if (entry && (path !== undefined || pkg !== undefined)) {
			// eslint-disable-next-line no-await-in-loop -- plugins load in config order
			plugins.push(await loadPlugin(name, entry, opts));
		}
	}

	return { config: { ...config, plugins: entries }, plugins };
};
