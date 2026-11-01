import { coreCodes } from "./codes.js";
import { isCutVersion } from "./cut.js";

import type { Warning } from "./errors.js";
import type { UnitFacts } from "./model/facts-types.js";
import type { BumpLevel, PreCtx, Unit, VersionScheme } from "./plugin.js";

/** A parsed `from` version; `label` names it in warnings. */
export interface From<V> {
	readonly version: V;
	readonly label: string;
}

/** The `from` version of a unit, from `facts.fromTag`. */
export const fromOf = <V>(
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

export const initialOf = <V>(unit: Unit, scheme: VersionScheme<V>): V =>
	(unit.initialVersion === null
		? undefined
		: scheme.parse(unit.initialVersion)) ?? scheme.initial();

/** `from` bumped by `bump`; the initial version on a first release. */
export const bumpedOf = <V>(
	scheme: VersionScheme<V>,
	bump: BumpLevel | null,
	{ from, initial }: { from: From<V> | undefined; initial: V },
): V | undefined =>
	bump === null
		? undefined
		: from === undefined
			? initial
			: scheme.bump(from.version, bump);

export const ctxOf = (
	unit: Unit,
	{ head, date }: { head: string; date?: string },
	at: {
		baseTag: { name: string } | null;
		tags: readonly string[];
		sinceLineBase: number;
		total: number;
	},
): PreCtx => ({
	unit,
	head,
	...(date === undefined ? {} : { date }),
	baseTag: at.baseTag?.name ?? null,
	tags: at.tags,
	firstParent: { sinceLineBase: at.sinceLineBase, total: at.total },
});

/**
 * `next`, prerelease of `raw` under `ctx` and its cut, numbered one past the
 * planned commit; the cut is null unless it has the cut form and sorts below
 * `next`.
 */
export const render = <V>({
	scheme,
	raw,
	ctx,
	channel,
	cut,
}: {
	scheme: VersionScheme<V>;
	raw: V | undefined;
	ctx: PreCtx;
	channel: string | null;
	cut: string | null;
}): {
	readonly next: string | null;
	readonly prerelease: string | null;
	readonly cut: string | null;
} => {
	if (raw === undefined) {
		return { next: null, prerelease: null, cut: null };
	}

	const next = scheme.release(raw, ctx);
	let cutVersion: string | null = null;
	if (cut !== null) {
		const { sinceLineBase, total } = ctx.firstParent;
		const candidate = scheme.prerelease(raw, {
			...ctx,
			channel: cut,
			firstParent: { sinceLineBase: sinceLineBase + 1, total: total + 1 },
		});
		if (
			isCutVersion(scheme, candidate, cut) &&
			scheme.compare(candidate, next) < 0
		) {
			cutVersion = scheme.format(candidate);
		}
	}

	return {
		next: scheme.format(next),
		prerelease:
			channel === null
				? null
				: scheme.format(scheme.prerelease(raw, { ...ctx, channel })),
		cut: cutVersion,
	};
};

/** Warns when a first release's initial version is not above the unit's highest prerelease tag. */
export const initialBelowPrerelease = <V>(
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
