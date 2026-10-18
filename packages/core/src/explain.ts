import { attribution, matcher } from "./attribution.js";
import { changelogPath } from "./changelog.js";
import { coreCodes } from "./codes.js";
import { planWithFacts } from "./plan.js";

import type { Warning } from "./errors.js";
import type { Plan, PlanChange, PlanOptions, UnitPlan } from "./plan.js";
import type { GitReader } from "./plugin.js";
import type { Workspace } from "./workspace.js";

export interface ExplainedChange extends PlanChange {
	/** Commit files attributed to the unit, or to `via`. */
	files: string[];
}

export interface ReleaseAsFooter {
	sha?: string;
	/** Raw value; qualified values without the unit prefix. */
	version: string;
	qualified: boolean;
	/** The value that set `releaseAs`. */
	applied: boolean;
}

/** Why a unit is affected and how its version is computed. */
export interface UnitExplanation {
	/** The plan with `all` set. */
	plan: Plan;
	/** Plan entry; null when the unit is neither affected nor pending. */
	unit: UnitPlan | null;
	/** The unit's fixed group. */
	group: { name: string; members: string[] } | null;
	/** Origin of the prerelease counter without a line base; see `UnitFacts`. */
	introduced: string | null;
	/** What set `unit.next`: the bump, the initial version or a Release-As value. */
	nextSource: "bump" | "initial" | "release-as" | null;
	/** Changed unit files (reason `direct`) or changed global inputs (`global`). */
	files: string[];
	/** Plan changes with their files, core commit order. */
	changes: ExplainedChange[];
	/** `pinned` is null when the dependency is reached through unreleased units. */
	propagatedFrom: { id: string; pinned: boolean | null }[];
	/** Release-As footers for the unit since its base tag, core commit order. */
	releaseAs: ReleaseAsFooter[];
	/** Plan warnings of the unit and those of no unit. */
	warnings: Warning[];
}

export interface ExplainOptions extends PlanOptions {
	/** Unit id. */
	unit: string;
}

/** Explains one unit of the plan of `opts.head`; throws `E_UNIT_UNKNOWN`. */
export const explainUnit = async (
	workspace: Workspace,
	git: GitReader,
	{ unit: id, ...opts }: ExplainOptions,
): Promise<UnitExplanation> => {
	if (!workspace.units.some((u) => u.id === id)) {
		throw coreCodes.error("E_UNIT_UNKNOWN", `unknown unit "${id}"`, {
			unit: id,
		});
	}

	const { plan, facts, releases } = await planWithFacts(workspace, git, {
		...opts,
		all: true,
	});
	const unit = plan.units.find((u) => u.id === id) ?? null;
	const ignored = matcher(workspace.ignore);
	const isGlobal = matcher(workspace.globalInputs);
	const owners = attribution(workspace.units);
	// As in `computeAffected`: a released unit owns its changelog.
	const changelogs = new Map(
		workspace.units
			.filter((u) => u.version !== "none")
			.map((u) => [changelogPath(u), u.id]),
	);
	const owned = (files: readonly string[], owner: string) =>
		files.filter((f) => {
			const own = changelogs.get(f);

			return own === undefined
				? !ignored(f) && !isGlobal(f) && owners(f).includes(owner)
				: own === owner && !isGlobal(f);
		});

	const { base } = plan.build;
	const reason = unit?.affected?.reason;
	const files =
		reason === "global"
			? plan.build.globalInputs
			: reason === "direct" && base !== null
				? owned(await git.diffFiles(base, opts.head), id)
				: [];

	const unitFacts = facts.units.find((f) => f.id === id);
	const commitFiles = new Map(
		unitFacts
			? (await git.log(unitFacts.from, opts.head)).map((c) => [c.sha, c.files])
			: [],
	);
	const changes = (unit?.changes ?? []).map((c) => ({
		...c,
		files: owned(commitFiles.get(c.sha ?? "") ?? [], c.via ?? id),
	}));

	const propagatedFrom = (unit?.propagatedFrom ?? []).map((from) => ({
		id: from,
		pinned:
			workspace.graph.edges.find((e) => e.from === from && e.to === id)
				?.pinned ?? null,
	}));

	const range = facts.ranges.find((r) => r.from === unitFacts?.from);
	const footers = (unitFacts ? (range?.changes ?? []) : []).flatMap(
		({ change, units }) =>
			(change.releaseAs ?? [])
				.filter(
					(r) => r.unit === id || (r.unit === undefined && units.includes(id)),
				)
				.map((r) => ({
					...(change.sha === undefined ? {} : { sha: change.sha }),
					version: r.version,
					qualified: r.unit !== undefined,
				})),
	);
	const winner = releases.get(id)?.releaseAsFooter;
	const applied = footers.findIndex(
		(f) => winner && f.sha === winner.sha && f.version === winner.raw,
	);

	const group = workspace.groups.find((g) => g.members.includes(id));

	return {
		plan,
		unit,
		group: group ? { name: group.name, members: [...group.members] } : null,
		introduced: unitFacts?.introduced ?? null,
		nextSource: releases.get(id)?.nextSource ?? null,
		files,
		changes,
		propagatedFrom,
		releaseAs: footers.map((f, i) => ({ ...f, applied: i === applied })),
		warnings: plan.warnings.filter(
			(w) => w.unit === id || w.unit === undefined,
		),
	};
};
