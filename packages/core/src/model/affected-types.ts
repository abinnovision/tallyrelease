import type { Warning } from "../errors.js";

export type BaseSource =
	| "cli"
	| "push-before"
	| "pr-merge-base"
	| "merge-group"
	| "forge-last-success"
	| "local-merge-base"
	| "none";

export type AffectedReason =
	"direct" | "dependent" | "global" | "all" | "group";

export interface AffectedUnit {
	id: string;
	/** Unit root, `.` for the repo root. */
	path: string;
	plugin: string;
	reason: AffectedReason;
	/** Affected direct dependencies of a dependent, or affected mates of a group member. */
	via: string[];
	/** True unless the unit's version is `none`. */
	released: boolean;
	/** Sorted unit tags. */
	tags: string[];
}

/** `tallyrelease affected --json`, schema 1. */
export interface AffectedDoc {
	schema: 1;
	tool: string;
	repo: string;
	branch: string;
	head: string;
	build: {
		base: string | null;
		baseSource: BaseSource;
		all: boolean;
		globalInputs: string[];
	};
	units: AffectedUnit[];
	unattributed: string[];
	warnings: Warning[];
}

export interface AffectedOptions {
	/** For example `tallyrelease@0.1.0`. */
	tool: string;
	branch: string;
	head: string;
	/** Null marks every unit affected without a diff. */
	base: string | null;
	baseSource: BaseSource;
}
