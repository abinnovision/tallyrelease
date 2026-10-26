import { coreCodes } from "./codes.js";

import type { CodeOf, WarningCode } from "./codes.js";
import type { Warning } from "./errors.js";
import type { AttributedChange, RangeFacts } from "./model/facts-types.js";
import type { Unit, VersionScheme } from "./plugin.js";
import type { From } from "./version-math.js";

interface CommitValues {
	sha?: string;
	/** Qualified values for the unit, else plain values of an attributed commit. */
	values: string[];
}

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

/** The Release-As footer value that applies to a unit. */
export interface ReleaseAsWinner<V> {
	readonly sha?: string;
	/** As written in the footer. */
	readonly raw: string;
	readonly version: V;
}

/** Release-As values per commit for one unit, in range order. */
export const commitValues = (
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

/** Newest valid value wins; invalid values and other values warn. */
export const pickReleaseAs = <V>(
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

/** Normalized value of the first valid Release-As of a commit. */
export const appliedValue = <V>(
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
