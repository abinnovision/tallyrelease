import type { BumpLevel } from "./plugin.js";

const LEVELS: readonly BumpLevel[] = ["patch", "minor", "major"];

/** Code-unit string order, independent of locale. */
export const compare = (a: string, b: string): number =>
	a < b ? -1 : a > b ? 1 : 0;

/** Sorted distinct values. */
export const uniqueSorted = (values: Iterable<string>): string[] =>
	[...new Set(values)].sort(compare);

/** The higher of two levels; null is lowest. */
export const maxLevel = (
	a: BumpLevel | null,
	b: BumpLevel | null,
): BumpLevel | null =>
	a === null || (b !== null && LEVELS.indexOf(b) > LEVELS.indexOf(a)) ? b : a;

/** Freezes every nested object; walks the whole value, so keep it off hot paths. */
const deepFreeze = (value: unknown): void => {
	if (typeof value === "object" && value !== null) {
		Object.values(value).forEach(deepFreeze);
		Object.freeze(value);
	}
};

/**
 * Deep-frozen copy of a JSON value, for hooks that must not change it.
 * Expensive (a full copy plus a walk over it): make one per pass and share it.
 */
export const frozenCopy = <T>(value: T): T => {
	const copy = JSON.parse(JSON.stringify(value)) as T;
	deepFreeze(copy);

	return copy;
};
