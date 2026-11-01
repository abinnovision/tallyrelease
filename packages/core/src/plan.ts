import { computeAffected } from "./affected.js";
import { checkLimits, matchBranch } from "./branches.js";
import { changeLevel, reach } from "./bump.js";
import { coreCodes } from "./codes.js";
import { collectPlanFacts } from "./facts.js";
import { pluginCtx, runHook } from "./plugins.js";
import { propagate } from "./propagate.js";
import { releaseAsWarnings } from "./release-as.js";
import { footerOf, releaseGroup, releaseUnit, unitIntent } from "./release.js";
import { noMatchingTag } from "./tags.js";
import { frozenCopy, maxLevel } from "./util.js";
import { validateRelease } from "./validate.js";

import type { Warning } from "./errors.js";
import type { AffectedUnit } from "./model/affected-types.js";
import type {
	CoreVersion,
	LimitCommit,
	LimitItem,
	LimitSubject,
	Line,
} from "./model/branch-types.js";
import type { PlanFacts, UnitFacts } from "./model/facts-types.js";
import type {
	GroupPlan,
	Plan,
	PlanChange,
	PlanOptions,
	ResolveInput,
	UnitPlan,
} from "./model/plan-types.js";
import type { GitReader, Unit } from "./plugin.js";
import type { Propagated } from "./propagate.js";
import type {
	GroupMember,
	ReleaseInput,
	UnitIntent,
	UnitRelease,
} from "./release.js";
import type { Workspace } from "./workspace.js";

const lineWarnings = (
	workspace: Workspace,
	branch: string,
	line: Line | null,
): Warning[] => {
	if (!line) {
		return [
			coreCodes.warning(
				"W_NO_BRANCH_RULE",
				`no branch rule matches "${branch}"; versions are null`,
			),
		];
	}

	return workspace.units.every((u) => u.version === "none")
		? [
				coreCodes.warning(
					"W_NO_RELEASED_UNITS",
					`branch rule "${line.rule}" matches, but no unit is released`,
				),
			]
		: [];
};

const planChanges = (intent: UnitIntent<unknown> | undefined): PlanChange[] =>
	(intent?.changes ?? []).map(({ change, via }) => {
		const releaseAs =
			change.sha === undefined
				? undefined
				: intent?.releaseAsBySha.get(change.sha);

		return {
			...(change.sha === undefined ? {} : { sha: change.sha }),
			type: change.type,
			breaking: change.breaking,
			...(change.scope === undefined ? {} : { scope: change.scope }),
			subject: change.subject,
			...(change.notes === undefined ? {} : { notes: change.notes }),
			...(change.pr === undefined ? {} : { pr: change.pr }),
			...(via === undefined ? {} : { via }),
			...(releaseAs === undefined ? {} : { releaseAs }),
		};
	});

/**
 * Release inputs of the released units with a scheme and range; the same set
 * bounds absorption here and propagation in `resolvePlan`.
 */
const releaseInputs = (
	workspace: Workspace,
	{ facts, schemes }: Pick<ResolveInput, "facts" | "schemes">,
	channel: string | null,
): Map<string, ReleaseInput<any>> => {
	const units = new Map(workspace.units.map((u) => [u.id, u]));
	const entries = facts.units.flatMap((unitFacts) => {
		const unit = units.get(unitFacts.id);
		const scheme = unit && schemes.get(unit.scheme);
		const range = facts.ranges.find((r) => r.from === unitFacts.from);

		return unit && scheme && range ? [{ unit, scheme, unitFacts, range }] : [];
	});
	const released = new Set(entries.map((e) => e.unit.id));

	return new Map(
		entries.map(({ unit, scheme, unitFacts, range }) => [
			unit.id,
			{
				unit,
				scheme,
				settings: workspace.release,
				facts: unitFacts,
				range,
				absorbed: reach(unit.id, workspace.graph.dependencies, released),
				head: facts.head,
				channel,
			},
		]),
	);
};

interface Entry {
	unit: Unit;
	group: string | null;
	hit: AffectedUnit | undefined;
	facts: UnitFacts | undefined;
	intent: UnitIntent<unknown> | undefined;
	release: UnitRelease | undefined;
	propagatedFrom: readonly string[];
	head: string;
}

const UNRELEASED: UnitRelease = {
	from: null,
	bump: null,
	releaseAs: null,
	releaseAsFooter: null,
	next: null,
	nextSource: null,
	prerelease: null,
};

/** The unit's plan entry; undefined when it is not listed. */
const unitPlan = (entry: Entry, all: boolean): UnitPlan | undefined => {
	const { unit, hit, facts } = entry;
	const release = entry.release ?? UNRELEASED;
	if (!hit && !(release.next !== null && all)) {
		return undefined;
	}

	const { prerelease } = release;
	const kind = !hit ? "none" : prerelease === null ? "rebuild" : "prerelease";

	return {
		id: unit.id,
		path: unit.root,
		plugin: unit.plugin,
		scheme: unit.scheme,
		tags: [...unit.tags],
		group: entry.group,
		affected: hit ? { reason: hit.reason, via: hit.via } : null,
		kind,
		baseTag: facts?.baseTag?.name ?? null,
		lineBaseTag: facts?.lineBaseTag?.name ?? null,
		from: release.from,
		bump: release.bump,
		releaseAs: release.releaseAs,
		propagatedFrom: [...entry.propagatedFrom],
		absorbedFrom: [...(entry.intent?.absorbedFrom ?? [])],
		next: release.next,
		version: kind === "prerelease" ? prerelease : null,
		sha: entry.head,
		changes: planChanges(entry.intent),
	};
};

/** The only release item (ungrouped released unit or group), else null. */
const singleItem = (workspace: Workspace): LimitSubject | null => {
	const grouped = new Set(workspace.groups.flatMap((g) => g.members));
	const items: LimitSubject[] = [
		...workspace.groups.map((g) => ({ unit: null, group: g.name })),
		...workspace.units
			.filter((u) => u.version !== "none" && !grouped.has(u.id))
			.map((u) => ({ unit: u.id, group: null })),
	];

	return items.length === 1 ? (items[0] ?? null) : null;
};

/**
 * Limit input of a release item over its member ids: the changes and
 * Release-As values that produce `next`.
 */
const limitItem = (
	item: LimitSubject & {
		ids: readonly string[];
		from: string | null;
		next: string | null;
	},
	units: {
		inputs: ReadonlyMap<string, ReleaseInput<any>>;
		intents: ReadonlyMap<string, UnitIntent<any>>;
	},
): LimitItem | undefined => {
	const first = item.ids
		.map((id) => units.inputs.get(id))
		.find((i) => i !== undefined);
	if (!first) {
		return undefined;
	}

	const { scheme, settings } = first;
	const core = (version: string | null): CoreVersion | null => {
		const parsed: unknown =
			version === null ? undefined : scheme.parse(version);
		if (parsed === undefined || version === null) {
			return null;
		}

		const { major, minor } = scheme.core(parsed);

		return { major, minor, version };
	};

	const from = core(item.from);
	// Keyed by sha, file-based changes by identity; members merge.
	const commits = new Map<unknown, LimitCommit>();
	for (const id of item.ids) {
		const input = units.inputs.get(id);
		const intent = units.intents.get(id);
		for (const unitChange of intent?.changes ?? []) {
			const { change, via } = unitChange;
			const key = change.sha ?? change;
			const prev = commits.get(key);
			const level = changeLevel(unitChange, settings, from?.major === 0);
			const entry: LimitCommit = {
				...(change.sha === undefined ? {} : { sha: change.sha }),
				subject: change.subject,
				level,
				...(via === undefined ? {} : { via }),
			};
			// The highest level wins; a direct change wins over an absorbed one.
			const kept =
				prev !== undefined &&
				maxLevel(prev.level, level) === prev.level &&
				(level !== prev.level || via !== undefined);
			commits.set(
				key,
				kept
					? prev
					: { ...entry, ...(prev?.releaseAs && { releaseAs: prev.releaseAs }) },
			);
		}

		const releaseAs = intent?.releaseAs;
		if (input && releaseAs) {
			const { sha } = releaseAs;
			const key = sha ?? `Release-As: ${releaseAs.raw}`;
			const { major, minor } = scheme.core(releaseAs.version);
			commits.set(key, {
				...(sha === undefined ? {} : { sha }),
				subject:
					input.range.changes.find(
						(c) => sha !== undefined && c.change.sha === sha,
					)?.change.subject ?? key,
				level: null,
				...commits.get(key),
				releaseAs: {
					major,
					minor,
					version: scheme.format(releaseAs.version),
				},
			});
		}
	}

	return {
		unit: item.unit,
		group: item.group,
		from,
		next: core(item.next),
		commits: [...commits.values()],
	};
};

/** Releases of fixed group members, by unit id, and the group entries. */
const resolveGroupReleases = (
	{ facts, affected }: Pick<ResolveInput, "facts" | "affected">,
	units: {
		inputs: ReadonlyMap<string, ReleaseInput<any>>;
		intents: ReadonlyMap<string, UnitIntent<any>>;
		propagated: ReadonlyMap<string, Propagated>;
	},
	warnings: Warning[],
): { releases: Map<string, UnitRelease>; groups: GroupPlan[] } => {
	const hits = new Set(affected.units.map((u) => u.id));
	const releases = new Map<string, UnitRelease>();
	const groups: GroupPlan[] = [];
	for (const group of facts.groups) {
		const members = group.members.flatMap((id): GroupMember<any>[] => {
			const input = units.inputs.get(id);
			const intent = units.intents.get(id);

			return input && intent
				? [
						{
							input,
							bump: units.propagated.get(id)?.bump ?? intent.bump,
							releaseAs: intent.releaseAs,
						},
					]
				: [];
		});
		if (members.length === 0) {
			continue;
		}

		const release = releaseGroup(group, members, warnings);
		for (const { input, releaseAs } of members) {
			releases.set(input.unit.id, {
				...release,
				from: input.facts.baseTag?.version ?? null,
				releaseAs:
					releaseAs === undefined
						? null
						: input.scheme.format(releaseAs.version),
				releaseAsFooter: footerOf(releaseAs),
			});
		}

		groups.push({
			name: group.name,
			members: [...group.members],
			baseTag: group.baseTag?.name ?? null,
			from: release.from,
			bump: release.bump,
			next: release.next,
			version: group.members.some((id) => hits.has(id))
				? release.prerelease
				: null,
		});
	}

	return { releases, groups };
};

/** `resolvePlan` with the release of each released unit. */
const resolveReleases = (
	workspace: Workspace,
	input: ResolveInput,
): { plan: Plan; releases: Map<string, UnitRelease> } => {
	const { affected, facts } = input;
	const { units: _, ...doc } = affected;
	const line = matchBranch(
		workspace.release.branches,
		affected.branch,
		singleItem(workspace),
	);
	const warnings = [
		...affected.warnings,
		...lineWarnings(workspace, affected.branch, line),
		...facts.warnings,
		...releaseAsWarnings(workspace.units, facts.ranges),
	];

	const rank = new Map(workspace.graph.order.map((id, i) => [id, i]));
	const ordered = [...workspace.units].sort(
		(a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0),
	);
	const hits = new Map(affected.units.map((u) => [u.id, u]));
	const factsById = new Map(facts.units.map((f) => [f.id, f]));
	const inputs = releaseInputs(workspace, input, line?.channel ?? null);
	const intents = new Map<string, UnitIntent<unknown>>(
		[...inputs].map(([id, i]) => [id, unitIntent(i, warnings)]),
	);
	const groupOf = new Map(
		workspace.groups.flatMap((g) => g.members.map((id) => [id, g.name])),
	);
	const propagated = propagate(
		workspace.graph,
		workspace.units,
		new Map(
			[...intents].map(([id, i]) => {
				const group = groupOf.get(id);

				return [
					id,
					{
						bump: i.bump,
						pending: i.bump !== null || i.releaseAs !== undefined,
						...(group === undefined ? {} : { group }),
					},
				];
			}),
		),
	);
	const { releases: groupReleases, groups } = resolveGroupReleases(
		input,
		{ inputs, intents, propagated },
		warnings,
	);

	const units: UnitPlan[] = [];
	const releases = new Map<string, UnitRelease>();
	for (const unit of ordered) {
		const { id } = unit;
		const unitInput = inputs.get(id);
		const intent = intents.get(id);
		const state = propagated.get(id);
		const release =
			groupReleases.get(id) ??
			(unitInput && intent
				? releaseUnit(
						unitInput,
						{ bump: state?.bump ?? intent.bump, releaseAs: intent.releaseAs },
						warnings,
					)
				: undefined);
		if (release) {
			releases.set(id, release);
		}

		const entry = unitPlan(
			{
				unit,
				group: groupOf.get(id) ?? null,
				hit: hits.get(id),
				facts: factsById.get(id),
				intent,
				release,
				propagatedFrom: state?.propagatedFrom ?? [],
				head: facts.head,
			},
			input.all,
		);
		if (entry) {
			units.push(entry);
		}
	}

	const limits = { inputs, intents };
	const rule = workspace.release.branches.find((r) => r.name === line?.rule);
	checkLimits(
		line,
		[
			...groups.flatMap(
				(g) =>
					limitItem(
						{
							unit: null,
							group: g.name,
							ids: g.members,
							from: g.from,
							next: g.next,
						},
						limits,
					) ?? [],
			),
			...ordered.flatMap((u) => {
				const release = releases.get(u.id);

				return groupOf.has(u.id) || !release
					? []
					: (limitItem(
							{
								unit: u.id,
								group: null,
								ids: [u.id],
								from: release.from,
								next: release.next,
							},
							limits,
						) ?? []);
			}),
		],
		{
			branch: affected.branch,
			implicit: rule?.unit === null && rule.group === null,
		},
	);

	warnings.push(...noMatchingTag(workspace.units, facts.units, facts.tagNames));

	return {
		plan: { ...doc, line, units, groups, released: [], warnings },
		releases,
	};
};

/** Warnings of the plugins' `validate` hooks, run in config order on one frozen copy of the plan. */
const pluginValidation = async (
	workspace: Workspace,
	plan: Plan,
	opts: PlanOptions,
): Promise<Warning[]> => {
	const warnings: Warning[] = [];
	const ctx = pluginCtx({ ...opts, repo: { name: workspace.repo } }, warnings);
	let frozen: Plan | undefined;
	for (const { plugin, options } of workspace.plugins) {
		const { validate } = plugin;
		if (validate) {
			const copy = (frozen ??= frozenCopy(plan));
			// eslint-disable-next-line no-await-in-loop -- hooks run in config order
			const messages = await runHook(plugin.name, "validate", async () => {
				const result = await validate(ctx(plugin.name, options), copy);
				if (result !== undefined && !Array.isArray(result)) {
					throw new TypeError("validate must return string[] or nothing");
				}

				return result ?? [];
			});
			for (const message of messages) {
				warnings.push(
					coreCodes.warning("W_PLUGIN", message, { plugin: plugin.name }),
				);
			}
		}
	}

	return warnings;
};

/** Release math over collected facts; no I/O. */
export const resolvePlan = (workspace: Workspace, input: ResolveInput): Plan =>
	resolveReleases(workspace, input).plan;

/** A plan with the facts it was resolved from. */
export interface PlanResult {
	plan: Plan;
	facts: PlanFacts;
	/** Releases of the released units with a scheme. */
	releases: ReadonlyMap<string, UnitRelease>;
}

/** `computePlan` keeping the collected facts, for `explainUnit`. */
export const planWithFacts = async (
	workspace: Workspace,
	git: GitReader,
	opts: PlanOptions,
): Promise<PlanResult> => {
	validateRelease(workspace);
	const affected = await computeAffected(workspace, git, opts);
	const facts = await collectPlanFacts(workspace, git, {
		head: opts.head,
		fs: opts.fs,
		...(opts.debug && { debug: opts.debug }),
	});
	const { plan, releases } = resolveReleases(workspace, {
		affected,
		facts,
		schemes: workspace.schemes,
		all: opts.all ?? false,
	});
	plan.warnings.push(...(await pluginValidation(workspace, plan, opts)));

	return { plan, facts, releases };
};

/**
 * Plans `head`: validates release config, computes the build set, collects
 * git and intent facts, resolves versions and kinds and runs the plugins'
 * `validate` hooks.
 */
export const computePlan = async (
	workspace: Workspace,
	git: GitReader,
	opts: PlanOptions,
): Promise<Plan> => (await planWithFacts(workspace, git, opts)).plan;
