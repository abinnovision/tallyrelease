import { maxLevel } from "./util.js";

import type { RangeFacts } from "./model/facts-types.js";
import type { BumpLevel, Change } from "./plugin.js";
import type { ReleaseSettings } from "./release-settings.js";

/**
 * A Change of a released unit; `via` names the first absorbed unit (by id) a
 * change not attributed to the unit came through.
 */
export interface UnitChange {
	readonly change: Change;
	readonly via?: string;
}

/**
 * Unreleased units reachable over `id`'s dependencies, never stepping into or
 * through a released unit.
 */
export const reach = (
	id: string,
	dependencies: ReadonlyMap<string, readonly string[]>,
	released: ReadonlySet<string>,
): Set<string> => {
	const found = new Set<string>();
	const queue = [id];
	for (const v of queue) {
		for (const w of dependencies.get(v) ?? []) {
			if (!released.has(w) && !found.has(w)) {
				found.add(w);
				queue.push(w);
			}
		}
	}

	return found;
};

/**
 * Level of one change. While the major is 0, breaking changes use
 * `preMajor.breaking` and changes whose type level is minor `preMajor.feat`.
 * An absorbed change contributes `bumps.absorbed` when its own level is set
 * (`minor` caps it at minor).
 */
export const changeLevel = (
	{ change, via }: UnitChange,
	settings: ReleaseSettings,
	preMajor: boolean,
): BumpLevel | null => {
	const typed = settings.bumps.get(change.type) ?? null;
	const level = change.breaking
		? preMajor
			? settings.preMajor.breaking
			: "major"
		: preMajor && typed === "minor"
			? settings.preMajor.feat
			: typed;

	if (via === undefined || level === null) {
		return level;
	}

	return settings.absorbed === "minor" && level !== "patch" ? "minor" : "patch";
};

/** Max level over the changes. */
export const ownBump = (
	changes: readonly UnitChange[],
	settings: ReleaseSettings,
	preMajor: boolean,
): BumpLevel | null =>
	changes.reduce<BumpLevel | null>(
		(bump, change) => maxLevel(bump, changeLevel(change, settings, preMajor)),
		null,
	);

/** Changes of the range attributed to the unit or to an absorbed unit. */
export const unitChanges = (
	id: string,
	range: RangeFacts,
	absorbed: ReadonlySet<string>,
): UnitChange[] =>
	range.changes.flatMap(({ change, units }) => {
		if (units.includes(id)) {
			return [{ change }];
		}

		const via = units.find((u) => absorbed.has(u));

		return via === undefined ? [] : [{ change, via }];
	});
