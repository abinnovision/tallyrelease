import type { BumpLevel } from "../plugin.js";

/** A normalized branch rule. */
export interface BranchRule {
	readonly name: string;
	readonly line: "default" | "maintenance";
	readonly channel: string | null;
	/** Release item of the absolute maintenance check. */
	readonly unit: string | null;
	readonly group: string | null;
}

/** The branch rule matching the planned branch. */
export interface Line {
	rule: string;
	kind: "default" | "maintenance";
	/** Rendered with the rule's captures. */
	channel: string | null;
	/** Maintenance rules: `minor` for `{major}`, `patch` with `{minor}`. */
	maxBump: "minor" | "patch" | null;
	absolute: {
		unit: string | null;
		group: string | null;
		major: number;
		minor?: number;
	} | null;
}

/** An ungrouped released unit or a fixed group. */
export interface LimitSubject {
	unit: string | null;
	group: string | null;
}

/** Major and minor of a version. */
export interface Core {
	major: number;
	minor: number;
}

/** A formatted version with its core. */
export interface CoreVersion extends Core {
	version: string;
}

/** A commit that contributes to a release item's `next`. */
export interface LimitCommit {
	sha?: string;
	subject: string;
	/** Null for a Release-As only commit. */
	level: BumpLevel | null;
	/** Absorbed unit the change came through. */
	via?: string;
	/** The Release-As value it sets. */
	releaseAs?: CoreVersion;
}

export interface LimitItem extends LimitSubject {
	/** Null on a first release. */
	from: CoreVersion | null;
	/** Null without a pending release. */
	next: CoreVersion | null;
	commits: readonly LimitCommit[];
}
