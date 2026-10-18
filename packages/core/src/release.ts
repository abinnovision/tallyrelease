import { coreCodes } from "./codes.js";
import { normalizeRoot } from "./discover.js";
import { compare, maxLevel, uniqueSorted } from "./util.js";

import type { CodeOf, WarningCode } from "./codes.js";
import type { ReleasePrMode, TallyConfig, VersionTemplate } from "./config.js";
import type { Warning } from "./errors.js";
import type {
	AttributedChange,
	GroupFacts,
	RangeFacts,
	UnitFacts,
} from "./facts.js";
import type {
	BumpLevel,
	Change,
	PreCtx,
	Unit,
	VersionScheme,
} from "./plugin.js";

const DEFAULT_TYPES: Readonly<Record<string, BumpLevel>> = {
	feat: "minor",
	fix: "patch",
	perf: "patch",
	revert: "patch",
};

interface CommitValues {
	sha?: string;
	/** Qualified values for the unit, else plain values of an attributed commit. */
	values: string[];
}

/** Release-As values per commit for one unit, in range order. */
const commitValues = (
	id: string,
	changes: readonly AttributedChange[],
): CommitValues[] => {
	const commits = new Map<
		string,
		{ sha?: string; qualified: string[]; plain: string[] }
	>();
	changes.forEach(({ change, units }, i) => {
		const key = change.sha ?? `#${String(i)}`;
		const entry = commits.get(key) ?? {
			...(change.sha === undefined ? {} : { sha: change.sha }),
			qualified: [],
			plain: [],
		};
		commits.set(key, entry);
		for (const r of change.releaseAs ?? []) {
			if (r.unit === id) {
				entry.qualified.push(r.version);
			} else if (r.unit === undefined && units.includes(id)) {
				entry.plain.push(r.version);
			}
		}
	});

	return [...commits.values()].map(({ qualified, plain, ...rest }) => ({
		...rest,
		values: qualified.length > 0 ? qualified : plain,
	}));
};

const at = (sha: string | undefined) => (sha === undefined ? "" : ` in ${sha}`);

/** A Release-As value without a single leading `v`, parsed by the scheme. */
const parseReleaseAs = <V>(scheme: VersionScheme<V>, raw: string) =>
	scheme.parse(raw.startsWith("v") ? raw.slice(1) : raw);

/** Why a parsed Release-As value is ignored, else undefined. */
const releaseAsProblem = <V>(
	scheme: VersionScheme<V>,
	version: V,
	from: From<V> | undefined,
): string | undefined => {
	if (scheme.isPrerelease(version)) {
		return "is a prerelease";
	}

	return from && scheme.compare(version, from.version) <= 0
		? `does not exceed ${from.label}`
		: undefined;
};

/** Newest valid value wins; invalid values and other values warn. */
const pickReleaseAs = <V>(
	input: {
		unit: Unit;
		scheme: VersionScheme<V>;
		from: From<V> | undefined;
		commits: readonly CommitValues[];
	},
	warnings: Warning[],
): ReleaseAsWinner<V> | undefined => {
	const { unit, scheme, from, commits } = input;
	let winner: ReleaseAsWinner<V> | undefined;
	for (const { sha, values } of commits) {
		for (const raw of values) {
			const version = parseReleaseAs(scheme, raw);
			const problem =
				version === undefined
					? `is not a ${unit.scheme} version`
					: releaseAsProblem(scheme, version, from);
			if (problem !== undefined || version === undefined) {
				warnings.push(
					coreCodes.warning(
						"W_RELEASE_AS_INVALID",
						`unit "${unit.id}": Release-As "${raw}"${at(sha)} ${problem ?? ""}; ignored`,
						{ unit: unit.id },
					),
				);
			} else if (!winner) {
				winner = { ...(sha === undefined ? {} : { sha }), raw, version };
			} else if (scheme.compare(version, winner.version) !== 0) {
				warnings.push(
					coreCodes.warning(
						"W_RELEASE_AS_CONFLICT",
						`unit "${unit.id}": Release-As "${winner.raw}"${at(winner.sha)} wins over "${raw}"${at(sha)}`,
						{ unit: unit.id },
					),
				);
			}
		}
	}

	return winner;
};

/**
 * Level of one change. While the major is 0, breaking changes use
 * `preMajor.breaking` and changes whose type level is minor `preMajor.feat`.
 * An absorbed change contributes `bumps.absorbed` when its own level is set
 * (`minor` caps it at minor).
 */
const changeLevel = (
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
const ownBump = (
	changes: readonly UnitChange[],
	settings: ReleaseSettings,
	preMajor: boolean,
): BumpLevel | null =>
	changes.reduce<BumpLevel | null>(
		(bump, change) => maxLevel(bump, changeLevel(change, settings, preMajor)),
		null,
	);

/** Changes of the range attributed to the unit or to an absorbed unit. */
const unitChanges = (
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

/** Warns when a first release's initial version is not above the unit's highest prerelease tag. */
const initialBelowPrerelease = <V>(
	scheme: VersionScheme<V>,
	initial: V,
	facts: UnitFacts,
): Warning[] => {
	const highest = facts.tags
		.filter((t) => {
			const v = scheme.parse(t.version);

			return v !== undefined && scheme.isPrerelease(v);
		})
		.at(-1);
	const version = highest && scheme.parse(highest.version);
	if (!highest || version === undefined) {
		return [];
	}

	return scheme.compare(initial, version) > 0
		? []
		: [
				coreCodes.warning(
					"W_INITIAL_BELOW_PRERELEASE",
					`unit "${facts.id}": initial version ${scheme.format(initial)} does not exceed prerelease tag "${highest.name}"`,
					{ unit: facts.id },
				),
			];
};

/** Normalized value of the first valid Release-As of a commit. */
const appliedValue = <V>(
	scheme: VersionScheme<V>,
	values: readonly string[],
): string | undefined => {
	for (const raw of values) {
		const version = parseReleaseAs(scheme, raw);
		if (version !== undefined && !scheme.isPrerelease(version)) {
			return scheme.format(version);
		}
	}

	return undefined;
};

/** The `from` version of a unit, from `facts.fromTag`. */
const fromOf = <V>(
	scheme: VersionScheme<V>,
	facts: UnitFacts,
): From<V> | undefined => {
	const tag = facts.fromTag;
	const version = tag === null ? undefined : scheme.parse(tag.version);

	return tag === null || version === undefined
		? undefined
		: {
				version,
				label:
					facts.group === null
						? tag.version
						: `${tag.version} (group ${facts.group})`,
			};
};

/** `from` bumped by `bump`; the initial version on a first release. */
const bumpedOf = <V>(
	scheme: VersionScheme<V>,
	bump: BumpLevel | null,
	{ from, initial }: { from: From<V> | undefined; initial: V },
): V | undefined =>
	bump === null
		? undefined
		: from === undefined
			? initial
			: scheme.bump(from.version, bump);

const ctxOf = (
	unit: Unit,
	head: string,
	at: {
		baseTag: { name: string } | null;
		tags: readonly string[];
		sinceLineBase: number;
		total: number;
	},
): PreCtx => ({
	unit,
	head,
	baseTag: at.baseTag?.name ?? null,
	tags: at.tags,
	firstParent: { sinceLineBase: at.sinceLineBase, total: at.total },
});

const initialOf = <V>(unit: Unit, scheme: VersionScheme<V>): V =>
	(unit.initialVersion === null
		? undefined
		: scheme.parse(unit.initialVersion)) ?? scheme.initial();

/** `next` and prerelease of `raw` under `ctx`. */
const render = <V>({
	scheme,
	raw,
	ctx,
	channel,
}: {
	scheme: VersionScheme<V>;
	raw: V | undefined;
	ctx: PreCtx;
	channel: string | null;
}): Pick<UnitRelease, "next" | "prerelease"> => ({
	next: raw === undefined ? null : scheme.format(scheme.release(raw, ctx)),
	prerelease:
		raw === undefined || channel === null
			? null
			: scheme.format(scheme.prerelease(raw, { ...ctx, channel })),
});

/** A parsed `from` version; `label` names it in warnings. */
interface From<V> {
	readonly version: V;
	readonly label: string;
}

/** The Release-As footer value that applies to a unit. */
export interface ReleaseAsWinner<V> {
	readonly sha?: string;
	/** As written in the footer. */
	readonly raw: string;
	readonly version: V;
}

/** A normalized branch rule. */
export interface BranchRule {
	readonly name: string;
	readonly line: "default" | "maintenance";
	readonly channel: string | null;
	/** Release item of the absolute maintenance check. */
	readonly unit: string | null;
	readonly group: string | null;
}

/** Release config with defaults applied. */
export interface ReleaseSettings {
	/** Commit type to level. */
	readonly bumps: ReadonlyMap<string, BumpLevel>;
	/** Levels used while `core(from).major == 0`. */
	readonly preMajor: { readonly breaking: BumpLevel; readonly feat: BumpLevel };
	/** Level cap of absorbed changes with a bump. */
	readonly absorbed: "patch" | "minor";
	/** In config order. */
	readonly branches: readonly BranchRule[];
	readonly releasePr: {
		readonly default: ReleasePrMode;
		/** Set by unit overlays, by unit id. */
		readonly units: ReadonlyMap<string, ReleasePrMode>;
		/** Set by groups, by group name. */
		readonly groups: ReadonlyMap<string, ReleasePrMode>;
	};
	/** Floating tag formats. */
	readonly floating: readonly string[];
	/** Version file templates by unit id. */
	readonly templates: ReadonlyMap<string, readonly VersionTemplate[]>;
}

/**
 * A Change of a released unit; `via` names the first absorbed unit (by id) a
 * change not attributed to the unit came through.
 */
export interface UnitChange {
	readonly change: Change;
	readonly via?: string;
}

/** Bump inputs of a released unit, before propagation. */
export interface UnitIntent<V> {
	/** Own and absorbed level. */
	readonly bump: BumpLevel | null;
	readonly releaseAs: ReleaseAsWinner<V> | undefined;
	/** Core commit order. */
	readonly changes: readonly UnitChange[];
	/** Absorbed units of the changes with `via`, sorted. */
	readonly absorbedFrom: readonly string[];
	/** Release-As value per commit sha, for the plan's change list. */
	readonly releaseAsBySha: ReadonlyMap<string, string>;
}

export interface UnitRelease {
	readonly from: string | null;
	readonly bump: BumpLevel | null;
	readonly releaseAs: string | null;
	/** The footer that set `releaseAs`. */
	readonly releaseAsFooter: {
		readonly sha?: string;
		readonly raw: string;
	} | null;
	/** Null without a pending bump or Release-As. */
	readonly next: string | null;
	/** What set `next`. */
	readonly nextSource: "bump" | "initial" | "release-as" | null;
	/** Prerelease of `next` on `channel`; null without a channel or `next`. */
	readonly prerelease: string | null;
}

export interface ReleaseInput<V> {
	readonly unit: Unit;
	readonly scheme: VersionScheme<V>;
	readonly settings: ReleaseSettings;
	readonly facts: UnitFacts;
	/** The range of `facts.from`. */
	readonly range: RangeFacts;
	/** Unreleased units absorbed by the unit (`reach`). */
	readonly absorbed: ReadonlySet<string>;
	readonly head: string;
	readonly channel: string | null;
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

/** Applies the defaults to `bumps` and `branches`. */
export const releaseSettings = (
	config: TallyConfig,
	units: readonly Unit[],
): ReleaseSettings => ({
	bumps: new Map(Object.entries({ ...DEFAULT_TYPES, ...config.bumps?.types })),
	absorbed: config.bumps?.absorbed ?? "patch",
	preMajor: {
		breaking: config.bumps?.preMajor?.breaking ?? "minor",
		feat: config.bumps?.preMajor?.feat ?? "minor",
	},
	branches: (config.branches ?? []).map((b) => ({
		name: b.name,
		line: b.line,
		channel: b.channel ?? null,
		unit: b.unit ?? null,
		group: b.group ?? null,
	})),
	releasePr: {
		default: config.defaults?.releasePr ?? "shared",
		units: new Map(
			Object.entries(config.units ?? {}).flatMap(([root, overlay]) => {
				const unit = units.find((u) => u.root === normalizeRoot(root));

				return unit && overlay.releasePr
					? [[unit.id, overlay.releasePr] as const]
					: [];
			}),
		),
		groups: new Map(
			Object.entries(config.groups ?? {}).flatMap(([name, group]) =>
				group.releasePr ? [[name, group.releasePr] as const] : [],
			),
		),
	},
	floating: config.tags?.floating ?? [],
	templates: new Map(
		Object.entries(config.units ?? {}).flatMap(([root, overlay]) => {
			const unit = units.find((u) => u.root === normalizeRoot(root));

			return unit && overlay.versionFiles
				? [[unit.id, overlay.versionFiles] as const]
				: [];
		}),
	),
});

/**
 * Warns for qualified Release-As values naming unknown or unreleased units and
 * for plain values on commits attributed to no released unit.
 */
export const releaseAsWarnings = (
	units: readonly Unit[],
	ranges: readonly RangeFacts[],
): Warning[] => {
	const known = new Set(units.map((u) => u.id));
	const released = new Set(
		units.filter((u) => u.version !== "none").map((u) => u.id),
	);
	const warnings = new Map<string, Warning>();
	const warn = (
		code: WarningCode<CodeOf<typeof coreCodes>>,
		message: string,
		unit?: string,
	) => {
		warnings.set(
			`${code}\0${message}`,
			coreCodes.warning(code, message, unit === undefined ? {} : { unit }),
		);
	};

	for (const { changes } of ranges) {
		for (const { change, units: owners } of changes) {
			for (const { unit, version } of change.releaseAs ?? []) {
				if (unit === undefined) {
					if (!owners.some((id) => released.has(id))) {
						warn(
							"W_RELEASE_AS_IGNORED",
							`Release-As "${version}"${at(change.sha)} is not attributed to a released unit`,
						);
					}
				} else if (!known.has(unit)) {
					warn(
						"W_RELEASE_AS_UNKNOWN",
						`Release-As "${unit}@${version}"${at(change.sha)} names unknown unit "${unit}"`,
					);
				} else if (!released.has(unit)) {
					warn(
						"W_RELEASE_AS_IGNORED",
						`Release-As "${unit}@${version}"${at(change.sha)} names unreleased unit "${unit}"`,
						unit,
					);
				}
			}
		}
	}

	return [...warnings.values()];
};

/**
 * Own and absorbed bump and Release-As of a released unit. Release-As values
 * are read newest first (core commit order); a single leading `v` is
 * stripped, as release-please does. Footers are not absorbed.
 */
export const unitIntent = <V>(
	input: ReleaseInput<V>,
	warnings: Warning[],
): UnitIntent<V> => {
	const { unit, scheme, facts } = input;
	const from = fromOf(scheme, facts);
	const changes = unitChanges(unit.id, input.range, input.absorbed);
	const commits = commitValues(unit.id, input.range.changes);

	return {
		bump: ownBump(
			changes,
			input.settings,
			from !== undefined && scheme.core(from.version).major === 0,
		),
		releaseAs: pickReleaseAs({ unit, scheme, from, commits }, warnings),
		changes,
		absorbedFrom: uniqueSorted(
			input.range.changes.flatMap(({ units }) =>
				units.includes(unit.id)
					? []
					: units.filter((u) => input.absorbed.has(u)),
			),
		),
		releaseAsBySha: new Map(
			commits.flatMap(({ sha, values }) => {
				const value = appliedValue(scheme, values);

				return sha === undefined || value === undefined ? [] : [[sha, value]];
			}),
		),
	};
};

/** The recorded footer of a Release-As winner. */
export const footerOf = <V>(
	winner: ReleaseAsWinner<V> | undefined,
): UnitRelease["releaseAsFooter"] =>
	winner
		? {
				...(winner.sha === undefined ? {} : { sha: winner.sha }),
				raw: winner.raw,
			}
		: null;

/**
 * `next` and prerelease of a released unit from its bump after propagation;
 * Release-As overrides `next`.
 */
export const releaseUnit = <V>(
	input: ReleaseInput<V>,
	intent: { bump: BumpLevel | null; releaseAs: ReleaseAsWinner<V> | undefined },
	warnings: Warning[],
): UnitRelease => {
	const { unit, scheme, facts } = input;
	const { bump } = intent;
	const releaseAs = intent.releaseAs?.version;
	const from = fromOf(scheme, facts);
	const initial = initialOf(unit, scheme);
	const bumped = bumpedOf(scheme, bump, { from, initial });
	if (from === undefined && releaseAs === undefined && bumped !== undefined) {
		warnings.push(...initialBelowPrerelease(scheme, initial, facts));
	}

	const raw = releaseAs ?? bumped;

	return {
		from: facts.baseTag?.version ?? null,
		bump,
		releaseAs: releaseAs === undefined ? null : scheme.format(releaseAs),
		releaseAsFooter: footerOf(intent.releaseAs),
		nextSource:
			raw === undefined
				? null
				: releaseAs !== undefined
					? "release-as"
					: from === undefined
						? "initial"
						: "bump",
		...render({
			scheme,
			raw,
			ctx: ctxOf(unit, input.head, {
				...facts,
				tags: facts.tags.map((t) => t.name),
			}),
			channel: input.channel,
		}),
	};
};

/** A fixed group member; `input.facts.fromTag` is the group base tag. */
export interface GroupMember<V> {
	readonly input: ReleaseInput<V>;
	/** After propagation and group raising. */
	readonly bump: BumpLevel | null;
	readonly releaseAs: ReleaseAsWinner<V> | undefined;
}

/**
 * Release of a fixed group with members sorted by id:
 * `next = max(bump(groupFrom, L), max_i releaseAs_i)`, the initial version
 * (max over members) instead of the bump on a first release. One `PreCtx`:
 * first member, group base tag, union of member tags, group line base
 * counter, max total.
 */
export const releaseGroup = <V>(
	group: GroupFacts,
	members: readonly GroupMember<V>[],
	warnings: Warning[],
): Omit<UnitRelease, "releaseAsFooter"> => {
	const [first] = members;
	if (!first) {
		throw new TypeError("a group has at least one member");
	}

	const { scheme, facts, channel, head } = first.input;
	const max = (a: V | undefined, b: V | undefined): V | undefined =>
		a === undefined || (b !== undefined && scheme.compare(b, a) > 0) ? b : a;
	const from = fromOf(scheme, facts);
	const bump = members.reduce<BumpLevel | null>(
		(level, m) => maxLevel(level, m.bump),
		null,
	);
	const releaseAs = members.reduce<V | undefined>(
		(value, m) => max(value, m.releaseAs?.version),
		undefined,
	);
	const initial = members.reduce<V>(
		(value, m) => max(value, initialOf(m.input.unit, scheme)) ?? value,
		initialOf(first.input.unit, scheme),
	);
	const bumped = bumpedOf(scheme, bump, { from, initial });
	if (from === undefined && releaseAs === undefined && bumped !== undefined) {
		for (const m of members) {
			warnings.push(...initialBelowPrerelease(scheme, initial, m.input.facts));
		}
	}

	const tags = members
		.flatMap((m) => m.input.facts.tags)
		.flatMap((t) => {
			const version = scheme.parse(t.version);

			return version === undefined ? [] : [{ name: t.name, version }];
		})
		.sort(
			(a, b) => scheme.compare(a.version, b.version) || compare(a.name, b.name),
		)
		.map((t) => t.name);
	const raw = max(bumped, releaseAs);
	const byReleaseAs =
		releaseAs !== undefined &&
		(bumped === undefined || scheme.compare(releaseAs, bumped) > 0);

	return {
		from: group.baseTag?.version ?? null,
		bump,
		releaseAs: releaseAs === undefined ? null : scheme.format(releaseAs),
		nextSource:
			raw === undefined
				? null
				: byReleaseAs
					? "release-as"
					: from === undefined
						? "initial"
						: "bump",
		...render({
			scheme,
			raw,
			ctx: ctxOf(first.input.unit, head, {
				baseTag: group.baseTag,
				tags,
				sinceLineBase: group.sinceLineBase,
				total: Math.max(...members.map((m) => m.input.facts.total)),
			}),
			channel,
		}),
	};
};

export { changeLevel };
