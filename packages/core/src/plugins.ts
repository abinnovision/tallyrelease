import { CORE_PLUGIN, corePlugin } from "./builtin.js";
import { coreCodes } from "./codes.js";
import { assertPlugin } from "./plugin.js";

import type { Warning } from "./errors.js";
import type { Ctx, MaybePromise, Plugin } from "./plugin.js";
import type { WorkspaceInput } from "./workspace.js";

/** An enabled plugin with its validated options. */
export interface ActivePlugin {
	readonly plugin: Plugin;
	readonly ctx: Ctx;
	/** False when `plugins.<name>.globalInputs: false`. */
	readonly globalInputs: boolean;
}

/** Frozen `Ctx` factory; warnings are tagged with the plugin name. */
export const pluginCtx =
	(env: Pick<WorkspaceInput, "fs" | "repo" | "debug">, warnings: Warning[]) =>
	(name: string, options: unknown): Ctx =>
		Object.freeze({
			options,
			repo: Object.freeze({ name: env.repo.name }),
			fs: env.fs,
			log: Object.freeze({
				warn: (message: string) => {
					warnings.push(
						coreCodes.warning("W_PLUGIN", message, { plugin: name }),
					);
				},
				debug: (message: string) => env.debug?.(`${name}: ${message}`),
			}),
		});

/**
 * Resolves core, then enabled plugins in config order, and validates their
 * options.
 */
export const activatePlugins = async (
	env: WorkspaceInput,
	warnings: Warning[],
): Promise<ActivePlugin[]> => {
	const active: ActivePlugin[] = [
		{
			plugin: corePlugin,
			ctx: pluginCtx(env, warnings)(CORE_PLUGIN, {}),
			globalInputs: true,
		},
	];
	for (const [name, raw] of Object.entries(env.config.plugins)) {
		const plugin = env.plugins.find((p) => p.name === name);
		if (!plugin) {
			throw coreCodes.error("E_PLUGIN_UNKNOWN", `unknown plugin "${name}"`, {
				plugin: name,
			});
		}

		assertPlugin(plugin);
		if (plugin.name === CORE_PLUGIN) {
			throw coreCodes.error(
				"E_PLUGIN_NAME",
				`plugin name "${CORE_PLUGIN}" is reserved for core built-ins`,
				{ plugin: name },
			);
		}

		const { globalInputs, ...rest } = raw ?? {};
		let options: unknown = rest;
		if (plugin.options) {
			// eslint-disable-next-line no-await-in-loop -- plugins load sequentially in config order
			const result = await plugin.options["~standard"].validate(rest);
			if (result.issues) {
				throw coreCodes.error(
					"E_PLUGIN_OPTIONS",
					`invalid options for plugin "${name}": ${result.issues.map((i) => i.message).join("; ")}`,
					{ plugin: name, issues: result.issues },
				);
			}

			options = result.value;
		}

		const ctx = pluginCtx(env, warnings)(name, options);
		active.push({ plugin, ctx, globalInputs: globalInputs !== false });
	}

	return active;
};

/** Awaits a plugin hook, wrapping thrown errors as `E_PLUGIN_HOOK`. */
export const runHook = async <T>(
	plugin: string,
	hook: string,
	call: () => MaybePromise<T>,
): Promise<T> => {
	try {
		return await call();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw coreCodes.error(
			"E_PLUGIN_HOOK",
			`plugin "${plugin}" failed in ${hook}: ${reason}`,
			{ plugin, hook, error },
		);
	}
};
