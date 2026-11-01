import { ownBump, unitChanges } from "./bump.js";
import { appliedValue, commitValues, pickReleaseAs } from "./release-as.js";
import { compare, maxLevel, uniqueSorted } from "./util.js";
import {
	bumpedOf,
	ctxOf,
	fromOf,
	initialBelowPrerelease,
	initialOf,
	render,
} from "./version-math.js";

import type { UnitChange } from "./bump.js";
import type { Warning } from "./errors.js";
import type { GroupFacts, RangeFacts, UnitFacts } from "./model/facts-types.js";
import type { BumpLevel, Unit, VersionScheme } from "./plugin.js";
import type { ReleaseAsWinner } from "./release-as.js";
import type { ReleaseSettings } from "./release-settings.js";

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
	/** Prerelease of `next` on `cut`, numbered one past `head`; null when it cannot be cut. */
	readonly cut: string | null;
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
	/** Committer date of `head`. */
	readonly date?: string;
	readonly channel: string | null;
	/** Cut channel. */
	readonly cut: string | null;
}

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
	const ctx = ctxOf(unit, input, {
		...facts,
		tags: facts.tags.map((t) => t.name),
	});
	if (from === undefined && releaseAs === undefined && bumped !== undefined) {
		warnings.push(
			...initialBelowPrerelease(scheme, scheme.release(initial, ctx), facts),
		);
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
		...render({ scheme, raw, ctx, channel: input.channel, cut: input.cut }),
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

	const { scheme, facts, channel, cut } = first.input;
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
	const ctx = ctxOf(first.input.unit, first.input, {
		baseTag: group.baseTag,
		tags,
		sinceLineBase: group.sinceLineBase,
		total: Math.max(...members.map((m) => m.input.facts.total)),
	});
	if (from === undefined && releaseAs === undefined && bumped !== undefined) {
		const released = scheme.release(initial, ctx);
		for (const m of members) {
			warnings.push(...initialBelowPrerelease(scheme, released, m.input.facts));
		}
	}

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
		...render({ scheme, raw, ctx, channel, cut }),
	};
};
