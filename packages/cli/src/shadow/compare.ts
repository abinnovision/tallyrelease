import { semver } from "@tallyrelease/core";

import type { Plan, UnitPlan, Warning } from "@tallyrelease/core";

/*
 * release-please (`splitMessages` in src/commit.ts) splits a message into
 * extra commits at a blank line followed by one of these types, and at
 * `BEGIN_NESTED_COMMIT` blocks.
 */
const SPLIT =
	/\n\n(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\(.*?\))?: |BEGIN_NESTED_COMMIT/;

/** `a > b` as semver; false when either does not parse. */
const higher = (a: string | null, b: string | null): boolean => {
	const [x, y] = [a, b].map((v) => (v === null ? undefined : semver.parse(v)));

	return x !== undefined && y !== undefined && semver.compare(x, y) > 0;
};

/** True when `v` is exactly the patch bump of `base`. */
const isPatchOf = (v: string | null, base: string | null): boolean => {
	const [x, y] = [v, base].map((s) =>
		s === null ? undefined : semver.parse(s),
	);

	return (
		x !== undefined &&
		y !== undefined &&
		semver.compare(x, semver.bump(y, "patch")) === 0
	);
};

/** Effective `separate-pull-requests` for a manifest path. */
const separatePr = (
	rpConfig: Readonly<Record<string, unknown>>,
	path: string,
): boolean => {
	const packages = rpConfig["packages"] as
		Record<string, Record<string, unknown> | undefined> | undefined;
	const own = packages?.[path]?.["separate-pull-requests"];

	return (own ?? rpConfig["separate-pull-requests"]) === true;
};

export type ShadowStatus =
	"match" | "mismatch" | "tallyrelease-only" | "rp-only";

/** Known divergence classes between tallyrelease and release-please. */
export type ShadowLabel =
	| "absorbed-internal"
	| "dependent-patch"
	| "group-vs-rp"
	| "release-config"
	| "separate-pr"
	| "squash-split";

export interface ShadowRow {
	/** Manifest path, else the unit root. */
	path: string;
	unit: string | null;
	status: ShadowStatus;
	/** Manifest value at `HEAD^1`. */
	before: string | null;
	/** Manifest value at `HEAD`. */
	after: string | null;
	/** tallyrelease `from`. */
	from: string | null;
	/** tallyrelease `next`. */
	next: string | null;
	/** Sorted. */
	labels: ShadowLabel[];
}

export interface ShadowUnit {
	id: string;
	path: string;
	released: boolean;
	dependsOn: readonly string[];
}

export interface CompareInput {
	/** Manifest at `HEAD^1`. */
	before: Readonly<Record<string, string>>;
	/** Manifest at `HEAD`. */
	after: Readonly<Record<string, string>>;
	/** Plan of `HEAD^1`. */
	plan: Pick<Plan, "units">;
	units: readonly ShadowUnit[];
	/** Parsed `release-please-config.json`. */
	rpConfig: Readonly<Record<string, unknown>>;
	/** Full commit messages by sha, for `squash-split`. */
	messages: ReadonlyMap<string, string>;
	/** Commit types with a bump level. */
	bumpTypes: ReadonlySet<string>;
}

/** True when release-please would split `message` into more commits. */
export const isSquashBody = (message: string): boolean => SPLIT.test(message);

/**
 * Compares the plan of `HEAD^1` with the manifest change of a release-please
 * merge. Rows are sorted by path; a label names a known divergence class only
 * when it explains the direction of the difference, and never changes the
 * status.
 */
export const compareShadow = (input: CompareInput): ShadowRow[] => {
	const { before, after, plan, units, rpConfig, messages, bumpTypes } = input;
	const changed = new Set(
		Object.keys(after).filter((path) => before[path] !== after[path]),
	);
	const unitByPath = new Map(units.map((u) => [u.path, u]));
	const pathById = new Map(units.map((u) => [u.id, u.path]));
	const planByPath = new Map(plan.units.map((u) => [u.path, u]));

	// release-please node-workspace patches dependents of changed paths.
	const dependentPatch = (row: ShadowRow, planned: UnitPlan | undefined) => {
		if (row.status === "rp-only") {
			const deps = unitByPath.get(row.path)?.dependsOn ?? [];

			return (
				isPatchOf(row.after, row.before) &&
				deps.some((id) => changed.has(pathById.get(id) ?? ""))
			);
		}

		return (
			row.status === "tallyrelease-only" &&
			(planned?.propagatedFrom.length ?? 0) > 0 &&
			isPatchOf(row.next, row.from)
		);
	};

	// tallyrelease is higher because of a bumping change from an absorbed unit.
	const absorbedInternal = (row: ShadowRow, planned: UnitPlan | undefined) =>
		(row.status === "tallyrelease-only" ||
			(row.status === "mismatch" && higher(row.next, row.after))) &&
		(planned?.changes ?? []).some(
			(c) => c.via !== undefined && (c.breaking || bumpTypes.has(c.type)),
		);

	// release-please is higher and split a squash body into more commits.
	const squashSplit = (row: ShadowRow, planned: UnitPlan | undefined) =>
		(row.status === "rp-only" ||
			(row.status === "mismatch" && higher(row.after, row.next))) &&
		(planned?.changes ?? []).some(
			(c) => c.sha !== undefined && isSquashBody(messages.get(c.sha) ?? ""),
		);

	const labels = (
		row: ShadowRow,
		planned: UnitPlan | undefined,
	): ShadowLabel[] => {
		if (row.status === "match") {
			return [];
		}

		const unit = unitByPath.get(row.path);
		const checks: [ShadowLabel, boolean][] = [
			["absorbed-internal", absorbedInternal(row, planned)],
			["dependent-patch", dependentPatch(row, planned)],
			["group-vs-rp", Boolean(planned?.group)],
			["release-config", !unit?.released || !(row.path in after)],
			[
				"separate-pr",
				row.status === "tallyrelease-only" && separatePr(rpConfig, row.path),
			],
			["squash-split", squashSplit(row, planned)],
		];

		return checks.filter(([, hit]) => hit).map(([label]) => label);
	};

	const rows: ShadowRow[] = [];
	for (const path of changed) {
		const unit = unitByPath.get(path);
		const planned = planByPath.get(path);
		const next = planned?.next ?? null;
		const value = after[path] ?? null;
		const row: ShadowRow = {
			path,
			unit: unit?.id ?? null,
			status: next === null ? "rp-only" : next === value ? "match" : "mismatch",
			before: before[path] ?? null,
			after: value,
			from: planned?.from ?? null,
			next,
			labels: [],
		};
		rows.push({ ...row, labels: labels(row, planned) });
	}

	for (const planned of plan.units) {
		if (planned.next === null || changed.has(planned.path)) {
			continue;
		}

		const row: ShadowRow = {
			path: planned.path,
			unit: planned.id,
			status: "tallyrelease-only",
			before: before[planned.path] ?? null,
			after: after[planned.path] ?? null,
			from: planned.from,
			next: planned.next,
			labels: [],
		};
		rows.push({ ...row, labels: labels(row, planned) });
	}

	return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

/** `tallyrelease shadow --out`, schema 1. */
export interface ShadowReport {
	schema: 1;
	tool: string;
	/** `--pin`. */
	pin: string | null;
	/** `GITHUB_SHA`. */
	sha: string | null;
	/** True with `--head`, or when `head` is not `GITHUB_SHA`. */
	replay: boolean;
	branch: string;
	head: string;
	/** `HEAD^1`, the planned commit; null for a root commit. */
	planned: string | null;
	manifest: string;
	skipped: { reason: "manifest" | "cap"; message: string } | null;
	rows: ShadowRow[];
	warnings: Warning[];
}

/** Rows that differ without a label explaining it. */
export const unlabelled = (rows: readonly ShadowRow[]) =>
	rows.filter((r) => r.status !== "match" && r.labels.length === 0);
