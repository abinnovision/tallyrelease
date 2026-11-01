import type { BumpLevel, Propagate, VersionSource } from "./plugin.js";

/** Release PR of a release item: the shared PR or its own. */
export type ReleasePrMode = "shared" | "separate";

/**
 * Config overlay for the unit at a root; creates a config-only unit if none is
 * discovered. A glob key (`*` matches one segment, not dot directories) never
 * creates units and cannot set `id`, `include`, `exclude` or `versionFiles`.
 */
export interface UnitOverlay {
	id?: string;
	include?: string[];
	exclude?: string[];
	/** Default `defaults.release`, else false. */
	release?: boolean;
	/** Overrides the plugin's source; applies only when released. */
	version?: VersionSource;
	scheme?: string;
	tagFormat?: string;
	propagate?: Propagate;
	/** Labels for filtering, each matching `/^[A-Za-z0-9._-]+$/`. */
	tags?: string[];
	/** First release version, parsed by the unit's scheme. */
	initialVersion?: string;
	/** Ungrouped released units only; default `defaults.releasePr`. */
	releasePr?: ReleasePrMode;
	/** Templated text replacements written on release. */
	versionFiles?: VersionTemplate[];
	/**
	 * CI build number of the release list, never part of the version. Allowed
	 * on glob keys; an exact key replaces the whole value.
	 */
	buildNumber?: { offset?: number };
}

/**
 * A text file holding a unit's version. `file` is relative to the repository
 * root; `pattern` uses `{id}`, `{version}`, `{major}`, `{minor}` and `{patch}`.
 * Without `pattern`, lines marked `# x-tallyrelease-version` or
 * `<!-- x-tallyrelease-version -->` are rewritten.
 */
export interface VersionTemplate {
	file: string;
	pattern?: string;
}

/** A branch rule; the first rule whose `name` matches the branch wins. */
export interface BranchConfig {
	/** Pattern with `*`, `{major}` and `{minor}`. */
	name: string;
	line: "default" | "maintenance";
	/** Prerelease channel, may use the `{major}`/`{minor}` captures of `name`. */
	channel?: string;
	/** Maintenance rules: the unit of the absolute check; excludes `group`. */
	unit?: string;
	/** Maintenance rules: the group of the absolute check; excludes `unit`. */
	group?: string;
}

export interface BumpsConfig {
	/** Commit type to level, merged over the defaults. */
	types?: Record<string, BumpLevel>;
	/** Levels used while the major version is 0. */
	preMajor?: { breaking?: BumpLevel; feat?: BumpLevel };
	/** Level of changes absorbed from unreleased dependencies, default `patch`. */
	absorbed?: "patch" | "minor";
}

/** A fixed group: members share one version. Selections are unioned. */
export interface GroupConfig {
	/** Member unit ids. */
	units?: string[];
	/** Selects released units with any of these tags. */
	tags?: string[];
	/** Default `defaults.releasePr`. */
	releasePr?: ReleasePrMode;
}

export interface DepConfig {
	from: string;
	to: string;
	pinned?: boolean;
	reason?: string;
}

/** Parsed `tallyrelease.yaml`, as passed by the cli. */
export interface TallyConfig {
	/**
	 * Enabled plugins in run order, mapped to their raw options. The core-owned
	 * key `globalInputs: false` disables that plugin's default global inputs.
	 */
	plugins: Record<string, Record<string, unknown> | null>;
	defaults?: {
		release?: boolean;
		tagFormat?: string;
		propagate?: Propagate;
		initialVersion?: string;
		/** Default `shared`. */
		releasePr?: ReleasePrMode;
	};
	/** Overlays keyed by unit root or glob; exact keys win over globs per field. */
	units?: Record<string, UnitOverlay>;
	deps?: DepConfig[];
	ignore?: string[];
	globalInputs?: string[];
	branches?: BranchConfig[];
	bumps?: BumpsConfig;
	/** Fixed groups by name; names follow the unit id pattern. */
	groups?: Record<string, GroupConfig>;
	tags?: {
		/** Floating tag formats with `{id}`, `{major}` and `{minor}`. */
		floating?: string[];
	};
}

/** Global input owned by core. */
export const CONFIG_FILE = "tallyrelease.yaml";
