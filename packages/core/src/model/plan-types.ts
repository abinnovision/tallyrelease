import type {
	AffectedDoc,
	AffectedOptions,
	AffectedReason,
} from "./affected-types.js";
import type { Line } from "./branch-types.js";
import type { PlanFacts } from "./facts-types.js";
import type { BumpLevel, ReadonlyFs, VersionScheme } from "../plugin.js";

export interface PlanChange {
	/** Absent for file-based changes. */
	sha?: string;
	type: string;
	breaking: boolean;
	scope?: string;
	subject: string;
	/** `BREAKING CHANGE` footer text. */
	notes?: string;
	pr?: number;
	/** Absorbed unit the change came through. */
	via?: string;
	/** Release-As value of this commit for the unit. */
	releaseAs?: string;
}

export interface UnitPlan {
	id: string;
	/** Unit root, `.` for the repo root. */
	path: string;
	plugin: string;
	scheme: string;
	tags: string[];
	group: string | null;
	affected: { reason: AffectedReason; via: string[] } | null;
	kind: "prerelease" | "rebuild" | "none";
	baseTag: string | null;
	lineBaseTag: string | null;
	/** Null on a first release. */
	from: string | null;
	bump: BumpLevel | null;
	releaseAs: string | null;
	propagatedFrom: string[];
	absorbedFrom: string[];
	next: string | null;
	version: string | null;
	/** The planned commit. */
	sha: string;
	/** Core commit order. */
	changes: PlanChange[];
}

export interface GroupPlan {
	name: string;
	members: string[];
	baseTag: string | null;
	from: string | null;
	bump: BumpLevel | null;
	next: string | null;
	version: string | null;
}

export interface ReleasedUnit {
	id: string;
	path: string;
	version: string;
	tag: string;
	floatingTags: string[];
	releaseSha: string;
	/** Not built from HEAD by this run (release sha differs from HEAD, or the unit is outside the build set). */
	catchUp: boolean;
	/** Null when not looked up (no forge, or a forge error in `plan`). */
	forge: ReleasedForge | null;
	line: "default" | "maintenance";
	/** Highest stable version tagged for the unit, never on a maintenance line. */
	latest: boolean;
}

export interface ReleasedForge {
	/** PR that merged the release sha. */
	pr: { number: number; url: string } | null;
	/** Forge release of the tag. */
	release: { url: string } | null;
}

/** `tallyrelease plan --json`, schema 1. */
export interface Plan extends Omit<AffectedDoc, "units"> {
	line: Line | null;
	/** Topological order, cycles by id. */
	units: UnitPlan[];
	/** Sorted by name. */
	groups: GroupPlan[];
	/** Stable releases in `(build.base, head]`; empty until filled. */
	released: ReleasedUnit[];
}

export interface PlanOptions extends AffectedOptions {
	/** Files at `head`, for intent source contexts. */
	fs: ReadonlyFs;
	/** Also list released units outside the build set with a pending release. */
	all?: boolean;
	debug?: (message: string) => void;
}

/** Inputs of `resolvePlan`, all collected before release math. */
export interface ResolveInput {
	affected: AffectedDoc;
	facts: PlanFacts;
	schemes: ReadonlyMap<string, VersionScheme<any>>;
	all: boolean;
}
