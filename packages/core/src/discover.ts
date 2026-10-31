import { coreCodes } from "./codes.js";
import { defaultUnitId } from "./plugin.js";
import { runHook } from "./plugins.js";
import { compare, uniqueSorted } from "./util.js";

import type { UnitOverlay } from "./config.js";
import type { Warning } from "./errors.js";
import type { Unit, UnitDraft } from "./plugin.js";
import type { ActivePlugin } from "./plugins.js";
import type { WorkspaceInput } from "./workspace.js";

const UNIT_ID = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;
const UNIT_TAG = /^[A-Za-z0-9._-]+$/;

interface Entry {
	plugin: string;
	draft: Omit<UnitDraft, "meta">;
	meta: Record<string, Readonly<Record<string, unknown>>>;
	/** From the config overlay only. */
	release?: boolean | undefined;
	/** From the config overlay only. */
	tags?: string[] | undefined;
	/** From the config overlay only. */
	initialVersion?: string | undefined;
}

/** Escapes glob metacharacters so a root matches literally. */
const escapeGlob = (path: string): string =>
	path.replace(/[[\]{}()!*?+@\\]/g, "\\$&");

const isInside = (path: string, root: string): boolean =>
	path !== root && (root === "." || path.startsWith(`${root}/`));

/** Fields a glob overlay cannot set. */
const GLOB_REJECTED = ["id", "include", "exclude", "versionFiles"] as const;

/**
 * Validates a glob key and returns its segments: each is `*` (any segment not
 * starting with `.`) or a literal.
 */
const globSegments = (
	key: string,
	root: string,
	overlay: UnitOverlay,
): string[] => {
	const segments = root.split("/");
	if (segments.some((s) => s !== "*" && s.includes("*"))) {
		throw coreCodes.error(
			"E_UNIT_GLOB",
			`unit overlay "${key}" may use "*" only as a whole path segment`,
			{ key },
		);
	}

	const field = GLOB_REJECTED.find((f) => overlay[f] !== undefined);
	if (field !== undefined) {
		throw coreCodes.error(
			"E_UNIT_GLOB",
			`unit overlay "${key}" cannot set "${field}" on a glob key`,
			{ key, field },
		);
	}

	return segments;
};

const globMatches = (segments: readonly string[], root: string): boolean => {
	const parts = root.split("/");

	return (
		parts.length === segments.length &&
		parts.every((p, i) =>
			segments[i] === "*" ? !p.startsWith(".") : segments[i] === p,
		)
	);
};

/** Merges draft fields; sets `release`, `tags` and `initialVersion` when defined. */
const applyOverlay = (
	entry: Entry,
	{ release, tags, initialVersion, ...overlay }: UnitOverlay,
): void => {
	entry.draft = { ...entry.draft, ...overlay };
	if (release !== undefined) {
		entry.release = release;
	}

	if (tags !== undefined) {
		entry.tags = tags;
	}

	if (initialVersion !== undefined) {
		entry.initialVersion = initialVersion;
	}
};

/** Drops `.` and empty segments; rejects absolute roots and `..` segments. */
export const normalizeRoot = (root: string): string => {
	const segments = root.split("/");
	if (root.startsWith("/") || segments.includes("..")) {
		throw coreCodes.error(
			"E_ROOT_INVALID",
			`root "${root}" must be repo-relative without ".." segments`,
			{ root },
		);
	}

	return segments.filter((s) => s !== "" && s !== ".").join("/") || ".";
};

/**
 * Runs `discover` hooks in config order, applies config overlays (glob keys
 * first, then exact keys) and fills defaults. Returns units sorted by id.
 */
export const discoverUnits = async (
	active: readonly ActivePlugin[],
	env: Pick<WorkspaceInput, "config" | "fs" | "repo">,
	warnings: Warning[] = [],
): Promise<Unit[]> => {
	const byRoot = new Map<string, Entry>();

	for (const { plugin, ctx } of active) {
		const discover = plugin.discover?.bind(plugin);
		if (!discover) {
			continue;
		}

		// eslint-disable-next-line no-await-in-loop -- hooks run sequentially in config order
		const drafts = await runHook(plugin.name, "discover", () => discover(ctx));
		for (const { meta, ...draft } of drafts) {
			const root = normalizeRoot(draft.root);
			const prior = byRoot.get(root);
			if (prior) {
				throw coreCodes.error(
					"E_DUPLICATE_ROOT",
					`root "${root}" is discovered by "${prior.plugin}" and "${plugin.name}"`,
					{ root, plugins: [prior.plugin, plugin.name] },
				);
			}

			byRoot.set(root, {
				plugin: plugin.name,
				draft: { ...draft, root },
				meta: meta ? { [plugin.name]: Object.freeze({ ...meta }) } : {},
			});
		}
	}

	const exact: [Entry, UnitOverlay][] = [];
	const globs: [string, string[], UnitOverlay][] = [];
	for (const [key, overlay] of Object.entries(env.config.units ?? {})) {
		const root = normalizeRoot(key);
		const invalid = overlay.tags?.find((t) => !UNIT_TAG.test(t));
		if (invalid !== undefined) {
			throw coreCodes.error(
				"E_UNIT_TAG",
				`tag "${invalid}" of unit at "${root}" must match ${UNIT_TAG.source}`,
				{ tag: invalid, root },
			);
		}

		if (root.includes("*")) {
			globs.push([key, globSegments(key, root, overlay), overlay]);
			continue;
		}

		let entry = byRoot.get(root);
		if (!entry) {
			entry = {
				plugin: "config",
				draft: { id: overlay.id ?? defaultUnitId(root, env.repo.name), root },
				meta: {},
			};
			byRoot.set(root, entry);
		}

		exact.push([entry, overlay]);
	}

	for (const [key, segments, overlay] of globs) {
		const matched = [...byRoot.entries()].filter(([root]) =>
			globMatches(segments, root),
		);
		if (matched.length === 0) {
			warnings.push(
				coreCodes.warning(
					"W_UNIT_GLOB_UNMATCHED",
					`unit overlay "${key}" matches no unit`,
				),
			);
		}

		for (const [, entry] of matched) {
			applyOverlay(entry, overlay);
		}
	}

	for (const [entry, overlay] of exact) {
		applyOverlay(entry, overlay);
	}

	const byId = new Map<string, Entry>();
	for (const entry of byRoot.values()) {
		const { id, root } = entry.draft;
		if (!UNIT_ID.test(id)) {
			throw coreCodes.error(
				"E_UNIT_ID",
				`unit id "${id}" at "${root}" must match ${UNIT_ID.source}`,
				{ id, root, plugin: entry.plugin },
			);
		}

		const prior = byId.get(id);
		if (prior) {
			throw coreCodes.error(
				"E_DUPLICATE_UNIT",
				`unit id "${id}" is used by "${prior.plugin}" at "${prior.draft.root}" and "${entry.plugin}" at "${root}"`,
				{
					id,
					owners: [
						{ plugin: prior.plugin, root: prior.draft.root },
						{ plugin: entry.plugin, root },
					],
				},
			);
		}

		byId.set(id, entry);
		if (root !== "." && !env.fs.exists(root)) {
			throw coreCodes.error(
				"E_ROOT_MISSING",
				`root "${root}" of unit "${id}" does not exist`,
				{ id, root },
			);
		}
	}

	const roots = [...byRoot.keys()].sort(compare);
	const { defaults } = env.config;

	return [...byId.values()]
		.map(({ plugin, draft, meta, release, tags, initialVersion }): Unit => {
			const { root } = draft;
			const nested = roots
				.filter((r) => isInside(r, root))
				.map((r) => `${escapeGlob(r)}/**`);

			return Object.freeze({
				id: draft.id,
				root,
				plugin,
				include: Object.freeze([
					...(draft.include ?? [
						root === "." ? "**" : `${escapeGlob(root)}/**`,
					]),
				]),
				exclude: Object.freeze([...nested, ...(draft.exclude ?? [])]),
				version:
					(release ?? defaults?.release ?? false)
						? (draft.version ?? "tag")
						: "none",
				scheme: draft.scheme ?? "semver",
				tagFormat:
					draft.tagFormat ??
					defaults?.tagFormat ??
					(root === "." ? "v{version}" : "{id}-v{version}"),
				propagate: draft.propagate ?? defaults?.propagate ?? "auto",
				tags: Object.freeze(uniqueSorted(tags ?? [])),
				initialVersion: initialVersion ?? defaults?.initialVersion ?? null,
				meta: Object.freeze(meta),
			});
		})
		.sort((a, b) => compare(a.id, b.id));
};
