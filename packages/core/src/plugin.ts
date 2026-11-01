import { coreCodes } from "./codes.js";

import type { Plan } from "./model/plan-types.js";
import type { StandardSchemaV1 } from "@standard-schema/spec";

const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;

export type MaybePromise<T> = T | Promise<T>;

export const PLUGIN_API_VERSION = 1;

export interface Plugin<O = unknown> {
	apiVersion: typeof PLUGIN_API_VERSION;
	name: string;
	/** Validates `plugins.<name>` minus core-owned keys (`globalInputs`). */
	options?: StandardSchemaV1<unknown, O>;
	discover?: (ctx: Ctx<O>) => MaybePromise<UnitDraft[]>;
	edges?: (ctx: Ctx<O>, units: readonly Unit[]) => MaybePromise<EdgeDraft[]>;
	/** Default global inputs of this plugin. */
	inputs?: (ctx: Ctx<O>) => MaybePromise<{ global?: string[] }>;
	/** Called only for units owned by this plugin. */
	versionFiles?: (ctx: Ctx<O>, unit: Unit) => MaybePromise<VersionFile[]>;
	schemes?: Record<string, VersionScheme<any>>;
	intent?: IntentSource<O>[];
	/** Checks the computed plan; returned messages become `W_PLUGIN` warnings. */
	// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- a hook without warnings returns nothing
	validate?: (ctx: Ctx<O>, plan: Plan) => MaybePromise<string[] | void>;
	/**
	 * Called only for units owned by this plugin with a changelog section.
	 * Returns the section that replaces the default `section`; it must start
	 * with a version heading of the released version and have no other.
	 */
	changelog?: (
		ctx: Ctx<O>,
		input: { unit: Unit; plan: Plan; section: string },
	) => MaybePromise<string>;
}

export interface Ctx<O = unknown> {
	readonly options: O;
	readonly repo: { readonly name: string };
	readonly fs: ReadonlyFs;
	/** Warnings land in the output document's `warnings`. */
	readonly log: { warn: (msg: string) => void; debug: (msg: string) => void };
}

/** Read-only file access with repo-relative POSIX paths. */
export interface ReadonlyFs {
	/** UTF-8 content, undefined if missing. */
	read: (path: string) => string | undefined;
	exists: (path: string) => boolean;
	/** Sorted matches; skips `.git`, `node_modules` and the top-level `vendor`. */
	glob: (patterns: string[], opts?: { dirs?: boolean }) => string[];
}

/** Read-only git access. */
export interface GitReader {
	/** All tags, peeled to commits. */
	tags: () => MaybePromise<readonly TagRef[]>;
	/** Tags reachable from `ref` (`git tag --merged`). */
	tagsMerged: (ref: string) => MaybePromise<readonly TagRef[]>;
	/** True if `a` is reachable from `b` (inclusive). */
	isAncestor: (a: string, b: string) => MaybePromise<boolean>;
	/** True if `a` is on the first-parent chain of `b` (inclusive). */
	isFirstParentAncestor: (a: string, b: string) => MaybePromise<boolean>;
	/** Commits in `from..to` without merges; files listed without rename detection. */
	log: (from: string | null, to: string) => MaybePromise<readonly RawCommit[]>;
	/** Commits on the first-parent chain of `to` not reachable from `from`. */
	countFirstParent: (from: string | null, to: string) => MaybePromise<number>;
	/** Tree-to-tree changed paths without rename detection, sorted. */
	diffFiles: (from: string, to: string) => MaybePromise<readonly string[]>;
	/**
	 * Oldest commit on the first-parent chain of `to` whose diff to its first
	 * parent (the empty tree for a root commit) touches a file under directory
	 * `path`; null if none.
	 */
	introduced: (path: string, to: string) => MaybePromise<string | null>;
	/** Committer date of `ref`, ISO 8601. */
	commitDate?: (ref: string) => MaybePromise<string>;
}

export interface TagRef {
	name: string;
	sha: string;
}

export interface RawCommit {
	sha: string;
	parents: string[];
	message: string;
	files: string[];
	/** Committer date, ISO 8601. */
	date: string;
}

export type Propagate = "auto" | "patch" | "rebuild";

/** Where a released unit's version lives. `file`: tags and version files; `tag`: tags only. */
export type VersionSource = "file" | "tag";

/** Effective mode; `none` when the unit is not released. */
export type VersionMode = VersionSource | "none";

export interface UnitDraft {
	id: string;
	root: string;
	include?: string[];
	exclude?: string[];
	/** Source if the unit is released; default `tag`. */
	version?: VersionSource;
	scheme?: string;
	tagFormat?: string;
	propagate?: Propagate;
	/** Stored at `unit.meta[plugin.name]`. */
	meta?: Record<string, unknown>;
}

export interface Unit {
	readonly id: string;
	readonly root: string;
	/** Owning plugin, `config` for config-only units. */
	readonly plugin: string;
	readonly include: readonly string[];
	readonly exclude: readonly string[];
	readonly version: VersionMode;
	readonly scheme: string;
	readonly tagFormat: string;
	readonly propagate: Propagate;
	/** From the config overlay; sorted, unique. */
	readonly tags: readonly string[];
	/** Config overlay, else `defaults.initialVersion`; null uses `scheme.initial()`. */
	readonly initialVersion: string | null;
	readonly meta: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** `to` depends on `from`. */
export interface EdgeDraft {
	from: string;
	to: string;
	reason: string;
	/** True when `to`'s published manifest changes with `from`'s version. */
	pinned: boolean;
}

export interface Edge {
	from: string;
	to: string;
	reasons: string[];
	pinned: boolean;
	sources: string[];
}

export interface VersionFile {
	path: string;
	read: (content: string) => string | undefined;
	write: (content: string, next: string, ctx: WriteCtx) => string;
}

export interface WriteCtx {
	unit: Unit;
	/** All units of the workspace. */
	units: readonly Unit[];
	/** Unit id to version in the current plan. */
	versions: ReadonlyMap<string, string>;
}

export type BumpLevel = "major" | "minor" | "patch";

export interface VersionScheme<V> {
	/** Undefined when `raw` is not a version of this scheme. */
	parse: (raw: string) => V | undefined;
	format: (v: V) => string;
	compare: (a: V, b: V) => number;
	core: (v: V) => { major: number; minor: number; patch: number };
	isPrerelease: (v: V) => boolean;
	initial: () => V;
	bump: (v: V, level: BumpLevel) => V;
	release: (next: V, ctx: PreCtx) => V;
	prerelease: (next: V, ctx: PreCtx & { channel: string }) => V;
}

/** Git-derived data passed to a scheme. */
export interface PreCtx {
	unit: Unit;
	/** Full sha of the planned commit. */
	head: string;
	baseTag: string | null;
	/** Committer date of `head`, ISO 8601; set when the git reader has `commitDate`. */
	date?: string;
	/** All tags of this unit, reachable or not, scheme-sorted. */
	tags: readonly string[];
	firstParent: {
		sinceLineBase: number;
		total: number;
	};
}

export interface IntentSource<O = unknown> {
	name: string;
	collect: (
		ctx: Ctx<O>,
		input: {
			from: string | null;
			to: string;
			commits: readonly RawCommit[];
			/** All units of the workspace. */
			units: readonly Unit[];
		},
	) => MaybePromise<Change[]>;
}

/** A `Release-As` value; `unit` is set by the qualified form `<unit>@<version>`. */
export interface ReleaseAsValue {
	unit?: string;
	version: string;
}

export interface Change {
	/** Commit-derived changes are attributed via that commit's files. */
	sha?: string;
	/** Explicit attribution. */
	units?: string[];
	type: string;
	breaking: boolean;
	scope?: string;
	subject: string;
	body?: string;
	/** `BREAKING CHANGE` footer text. */
	notes?: string;
	releaseAs?: ReleaseAsValue[];
	pr?: number;
	date?: string;
	/**
	 * Files consumed when the change is released: deleted in the release
	 * commit that releases every unit named by the changes with the file.
	 */
	files?: string[];
}

/** Throws `E_PLUGIN_API` or `E_PLUGIN_NAME` for an unsupported plugin. */
export const assertPlugin = (plugin: {
	apiVersion: unknown;
	name: unknown;
}): void => {
	const name = String(plugin.name);
	if (plugin.apiVersion !== PLUGIN_API_VERSION) {
		throw coreCodes.error(
			"E_PLUGIN_API",
			`plugin "${name}" uses API version ${String(plugin.apiVersion)}, supported is ${String(PLUGIN_API_VERSION)}`,
			{ plugin: name, apiVersion: plugin.apiVersion },
		);
	}

	if (typeof plugin.name !== "string" || !PLUGIN_NAME.test(plugin.name)) {
		throw coreCodes.error(
			"E_PLUGIN_NAME",
			`plugin name "${name}" must match ${PLUGIN_NAME.source}`,
			{ plugin: name },
		);
	}
};

/** Validates name and API version, returns the plugin unchanged. */
export const definePlugin = <O>(plugin: Plugin<O>): Plugin<O> => {
	assertPlugin(plugin);

	return plugin;
};

/** `.` maps to the repo name, any other root to its last segment. */
export const defaultUnitId = (root: string, repoName: string): string =>
	root === "." ? repoName : (root.split("/").at(-1) ?? root);
