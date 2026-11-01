import type { Warning } from "../errors.js";
import type { Change } from "../plugin.js";
import type { UnitTag } from "../tags.js";

/** A Change with the ids of the units it is attributed to. */
export interface AttributedChange {
	readonly change: Change;
	/** Sorted. */
	readonly units: readonly string[];
}

/**
 * Changes of `(from, head]`, in core commit order, attributed to all units. A
 * unit's consumers read only its own range (`UnitFacts.from`), filtered to the
 * unit and the units it absorbs.
 */
export interface RangeFacts {
	readonly from: string | null;
	readonly changes: readonly AttributedChange[];
}

export interface UnitFacts {
	readonly id: string;
	/** Fixed group name. */
	readonly group: string | null;
	/**
	 * Range key, null from the root: the base tag commit; for a group member
	 * its own base tag when that descends from the group base tag, else the
	 * group base tag.
	 */
	readonly from: string | null;
	/** Every matched tag, reachable or not, scheme-sorted. */
	readonly tags: readonly UnitTag[];
	/** Highest stable tag merged into head. */
	readonly baseTag: UnitTag | null;
	/** Source of the `from` version: the group base tag for members, else `baseTag`. */
	readonly fromTag: UnitTag | null;
	/** Highest stable tag on head's first-parent chain. */
	readonly lineBaseTag: UnitTag | null;
	/**
	 * Without a line base and with a root other than `.`: the oldest commit on
	 * head's first-parent chain that touches the unit root.
	 */
	readonly introduced: string | null;
	/**
	 * First-parent commits since the line base; without one, since and
	 * including `introduced`, else `total`.
	 */
	readonly sinceLineBase: number;
	readonly total: number;
	/** Changes since the base tag attributed to this unit, core commit order. */
	readonly changes: readonly AttributedChange[];
	/** Qualified Release-As values naming this unit, core commit order. */
	readonly releaseAs: readonly { sha?: string; version: string }[];
}

/**
 * A fixed group. Base and line base are the highest member tags as for a
 * unit; equal versions prefer the tag whose commit descends from the other's.
 */
export interface GroupFacts {
	readonly name: string;
	readonly members: readonly string[];
	/** Highest stable member tag merged into head. */
	readonly baseTag: UnitTag | null;
	/** Highest stable member tag on head's first-parent chain. */
	readonly lineBaseTag: UnitTag | null;
	/** Without a line base, the max over the members. */
	readonly sinceLineBase: number;
}

/** Git and intent data of every released unit, collected before release math. */
export interface PlanFacts {
	readonly head: string;
	/** Committer date of `head`; set when the git reader has `commitDate`. */
	readonly date?: string;
	/** Released units, sorted by id. */
	readonly units: readonly UnitFacts[];
	/** One entry per distinct base tag commit. */
	readonly ranges: readonly RangeFacts[];
	/** Sorted by name. */
	readonly groups: readonly GroupFacts[];
	/** Every tag name, sorted. */
	readonly tagNames: readonly string[];
	/** Warnings logged by intent sources and for unknown explicit units. */
	readonly warnings: readonly Warning[];
}
