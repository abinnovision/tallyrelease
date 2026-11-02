import picomatch from "picomatch/posix.js";

import { coreCodes } from "./codes.js";
import { parseCommit } from "./conventional.js";
import { compare, uniqueSorted } from "./util.js";

import type { AttributionConfig } from "./config.js";
import type { Unit } from "./plugin.js";

export type PathMatcher = (path: string) => boolean;

/** Matches any of `patterns`; an empty list matches nothing. */
export const matcher = (patterns: readonly string[]): PathMatcher =>
	patterns.length === 0 ? () => false : picomatch([...patterns], { dot: true });

/** Returns the ids of units owning a path: `include` matches, `exclude` does not. */
export const attribution = (
	units: readonly Unit[],
): ((path: string) => string[]) => {
	const owners = units.map((u) => ({
		id: u.id,
		include: matcher(u.include),
		exclude: matcher(u.exclude),
	}));

	return (path) =>
		owners.filter((o) => o.include(path) && !o.exclude(path)).map((o) => o.id);
};

/** Resolved `attribution` config. */
export interface ScopeRules {
	readonly mode: "paths" | "narrow";
	/** Scope to sorted unit ids. */
	readonly scopes: ReadonlyMap<string, readonly string[]>;
}

/** Resolves `attribution`; throws `E_ATTRIBUTION_UNKNOWN_UNIT`. */
export const resolveAttribution = (
	units: readonly Unit[],
	config: AttributionConfig | undefined,
): ScopeRules => {
	const known = new Set(units.map((u) => u.id));
	const scopes = new Map<string, string[]>();
	for (const scope of Object.keys(config?.scopes ?? {}).sort(compare)) {
		const ids = config?.scopes?.[scope] ?? [];
		const unknown = ids.find((id) => !known.has(id));
		if (unknown !== undefined) {
			throw coreCodes.error(
				"E_ATTRIBUTION_UNKNOWN_UNIT",
				`attribution scope "${scope}" names unknown unit "${unknown}"`,
				{ scope, unit: unknown },
			);
		}

		scopes.set(scope, uniqueSorted(ids));
	}

	return { mode: config?.mode ?? "paths", scopes };
};

/**
 * Units mapped by the header scope of `message`. The scope is split on `,`,
 * each part is trimmed and matched exactly; the result is the sorted union.
 */
export const scopeUnits = (rules: ScopeRules, message: string): string[] => {
	if (rules.scopes.size === 0) {
		return [];
	}

	const parts = parseCommit(message).scope?.split(",") ?? [];

	return uniqueSorted(parts.flatMap((p) => rules.scopes.get(p.trim()) ?? []));
};

/**
 * Units of a commit with path owners `owners` and scoped units `scoped`:
 * `owners` without scoped units, else their union (`paths`) or `scoped` alone
 * (`narrow`).
 */
export const scopedUnits = (
	rules: ScopeRules,
	owners: readonly string[],
	scoped: readonly string[],
): string[] => {
	if (scoped.length === 0) {
		return [...owners];
	}

	return rules.mode === "narrow"
		? [...scoped]
		: uniqueSorted([...owners, ...scoped]);
};
