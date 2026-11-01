import { CONFIG_FILE } from "./config.js";
import { discoverUnits } from "./discover.js";
import { buildGraph } from "./graph.js";
import { resolveGroups } from "./groups.js";
import { activatePlugins, runHook } from "./plugins.js";
import { releaseSettings } from "./release-settings.js";
import { schemeRegistry } from "./schemes.js";
import { uniqueSorted } from "./util.js";

import type { TallyConfig } from "./config.js";
import type { Warning } from "./errors.js";
import type { Graph, SourcedEdge } from "./graph.js";
import type { Group } from "./groups.js";
import type {
	IntentSource,
	Plugin,
	ReadonlyFs,
	Unit,
	VersionFile,
	VersionScheme,
} from "./plugin.js";
import type { ActivePlugin } from "./plugins.js";
import type { ReleaseSettings } from "./release-settings.js";

const collectEdges = async (
	active: readonly ActivePlugin[],
	config: TallyConfig,
	units: readonly Unit[],
): Promise<SourcedEdge[]> => {
	const edges: SourcedEdge[] = [];
	const frozen = Object.freeze([...units]);
	for (const { plugin, ctx } of active) {
		const hook = plugin.edges?.bind(plugin);
		if (!hook) {
			continue;
		}

		// eslint-disable-next-line no-await-in-loop -- hooks run sequentially in config order
		const drafts = await runHook(plugin.name, "edges", () => hook(ctx, frozen));
		edges.push(...drafts.map((d) => ({ ...d, source: plugin.name })));
	}

	for (const { from, to, pinned, reason } of config.deps ?? []) {
		edges.push({
			from,
			to,
			pinned: pinned ?? false,
			reason: reason ?? "config",
			source: "config",
		});
	}

	return edges;
};

const collectGlobalInputs = async (
	active: readonly ActivePlugin[],
	config: TallyConfig,
	configFile: string,
): Promise<string[]> => {
	const globs = [configFile, ...(config.globalInputs ?? [])];
	for (const { plugin, ctx, globalInputs } of active) {
		const hook = plugin.inputs?.bind(plugin);
		if (!hook || !globalInputs) {
			continue;
		}

		// eslint-disable-next-line no-await-in-loop -- hooks run sequentially in config order
		const inputs = await runHook(plugin.name, "inputs", () => hook(ctx));
		globs.push(...(inputs.global ?? []));
	}

	return uniqueSorted(globs);
};

/**
 * Plugin version files of released units with version source `file`, by unit
 * id; hooks run on the first call only.
 */
const versionFilesOf = (
	active: readonly ActivePlugin[],
	units: readonly Unit[],
): (() => Promise<ReadonlyMap<string, readonly VersionFile[]>>) => {
	let files: Promise<Map<string, readonly VersionFile[]>> | undefined;
	const collect = async () => {
		const found = new Map<string, readonly VersionFile[]>();
		for (const { plugin, ctx } of active) {
			const hook = plugin.versionFiles?.bind(plugin);
			for (const unit of units) {
				if (!hook || unit.plugin !== plugin.name || unit.version !== "file") {
					continue;
				}

				// eslint-disable-next-line no-await-in-loop -- hooks run sequentially in config order
				const list = await runHook(plugin.name, "versionFiles", () =>
					hook(ctx, unit),
				);
				found.set(unit.id, list);
			}
		}

		return found;
	};

	return async () => await (files ??= collect());
};

/** An intent source with its plugin's validated options; callers build the `Ctx`. */
export interface IntentEntry {
	readonly plugin: string;
	readonly options: unknown;
	readonly source: IntentSource;
}

export interface WorkspaceInput {
	config: TallyConfig;
	/** Available plugins; `config.plugins` selects and orders them. */
	plugins: readonly Plugin[];
	fs: ReadonlyFs;
	repo: { name: string };
	debug?: (message: string) => void;
	/** Repo-relative config file path, a global input; defaults to `CONFIG_FILE`. */
	configFile?: string;
}

/** Units, graph and path rules of a repo at one commit. */
export interface Workspace {
	readonly repo: string;
	/** Sorted by id. */
	readonly units: readonly Unit[];
	readonly graph: Graph;
	/** Sorted globs. */
	readonly globalInputs: readonly string[];
	readonly ignore: readonly string[];
	readonly warnings: readonly Warning[];
	/** Registered schemes by name; `validateRelease` throws on a clash. */
	readonly schemes: ReadonlyMap<string, VersionScheme<any>>;
	/** Core sources first, then enabled plugins in config order. */
	readonly intents: readonly IntentEntry[];
	/** Core first, then enabled plugins in config order, with their options. */
	readonly plugins: readonly {
		readonly plugin: Plugin;
		readonly options: unknown;
	}[];
	/** Bumps and branch rules with defaults applied. */
	readonly release: ReleaseSettings;
	/** Fixed groups, sorted by name. */
	readonly groups: readonly Group[];
	/** Plugin version files of released units by unit id; runs the hooks once. */
	readonly versionFiles: () => Promise<
		ReadonlyMap<string, readonly VersionFile[]>
	>;
}

/** Runs plugin hooks sequentially in config order and builds the graph. */
export const loadWorkspace = async (
	input: WorkspaceInput,
): Promise<Workspace> => {
	const warnings: Warning[] = [];
	const active = await activatePlugins(input, warnings);
	const units = await discoverUnits(active, input, warnings);
	const graph = buildGraph(
		units,
		await collectEdges(active, input.config, units),
	);
	const globalInputs = await collectGlobalInputs(
		active,
		input.config,
		input.configFile ?? CONFIG_FILE,
	);

	const groups = resolveGroups(units, input.config.groups, warnings);

	const intents = active.flatMap(({ plugin, ctx }) =>
		(plugin.intent ?? []).map((source) => ({
			plugin: plugin.name,
			options: ctx.options,
			source,
		})),
	);

	return {
		repo: input.repo.name,
		units,
		graph,
		globalInputs,
		ignore: input.config.ignore ?? [],
		warnings: [...warnings, ...graph.warnings],
		schemes: schemeRegistry(active.map((a) => a.plugin)),
		intents,
		plugins: active.map(({ plugin, ctx }) => ({
			plugin,
			options: ctx.options,
		})),
		release: releaseSettings(input.config, units),
		groups,
		versionFiles: versionFilesOf(active, units),
	};
};
