import { coreCodes } from "./codes.js";
import { compare } from "./util.js";

import type { Warning } from "./errors.js";
import type { Group } from "./groups.js";
import type { TagRef, Unit, VersionScheme } from "./plugin.js";

const SPECIAL = /[\\^$.*+?()[\]{}|/]/gu;

const overlap = (units: string[], detail: Record<string, string>) =>
	coreCodes.error(
		"E_TAG_FORMAT_OVERLAP",
		`released units "${units.join('", "')}" share tags (${Object.values(detail).join(", ")})`,
		{ units, ...detail },
	);

/** A unit's `tagFormat` compiled to an anchored regex. */
export interface TagFormat {
	/** The format with `{id}` substituted. */
	readonly rendered: string;
	/** The raw `{version}` part of a matching tag, else undefined. */
	match: (tag: string) => string | undefined;
}

/** A tag of a unit whose `{version}` part parses with the unit's scheme. */
export interface UnitTag {
	readonly name: string;
	readonly sha: string;
	readonly version: string;
}

/** Compiles `format`; literal parts and `{id}` are escaped, `{version}` must occur once. */
export const compileTagFormat = (format: string, unitId: string): TagFormat => {
	const parts = format.split("{version}");
	if (parts.length !== 2) {
		throw coreCodes.error(
			"E_TAG_FORMAT",
			`tag format "${format}" of unit "${unitId}" must contain {version} exactly once`,
			{ unit: unitId, format },
		);
	}

	const literal = (part: string) =>
		part.replaceAll("{id}", unitId).replace(SPECIAL, "\\$&");
	const re = new RegExp(
		`^${literal(parts[0] ?? "")}(.+)${literal(parts[1] ?? "")}$`,
		"u",
	);

	return {
		rendered: format.replaceAll("{id}", unitId),
		match: (tag) => re.exec(tag)?.[1],
	};
};

/** The unit's tag for `version`. */
export const renderTag = (
	unit: Pick<Unit, "id" | "tagFormat">,
	version: string,
): string =>
	unit.tagFormat
		.replaceAll("{id}", unit.id)
		.replace("{version}", () => version);

/** The group of a member of a group with `tagFormat`, else the unit; its format renders the unit's tags. */
export const tagOwner = (
	groups: readonly Group[],
	unit: Pick<Unit, "id" | "tagFormat">,
): Pick<Unit, "id" | "tagFormat"> => {
	const group = groups.find(
		(g) => g.tagFormat !== null && g.members.includes(unit.id),
	);

	return group?.tagFormat
		? { id: group.name, tagFormat: group.tagFormat }
		: unit;
};

/** Tags of a released unit and its scheme. */
export interface UnitTags {
	readonly scheme: VersionScheme<any>;
	/** Sorted by scheme order, then name. */
	readonly tags: UnitTag[];
}

/**
 * Tags of each released unit, sorted by scheme order, then name. Unreleased
 * units never match. A member of a group with `tagFormat` matches the group's
 * format, then its own. Throws `E_TAG_FORMAT_OVERLAP` if two released units
 * render the same format or a tag parses for more than one of them, unless
 * all of them are members of the same group with `tagFormat`.
 */
export const matchUnitTags = (
	{
		units,
		schemes,
		groups,
	}: {
		units: readonly Unit[];
		schemes: ReadonlyMap<string, VersionScheme<any>>;
		groups: readonly Group[];
	},
	tags: readonly TagRef[],
): Map<string, UnitTags> => {
	const released = units
		.filter((u) => u.version !== "none")
		.map((unit) => {
			const scheme = schemes.get(unit.scheme);
			if (!scheme) {
				throw coreCodes.error(
					"E_SCHEME_UNKNOWN",
					`unit "${unit.id}" uses unknown scheme "${unit.scheme}"`,
					{ unit: unit.id, scheme: unit.scheme },
				);
			}

			const owner = tagOwner(groups, unit);
			const formats = [owner, unit]
				.map((u) => compileTagFormat(u.tagFormat, u.id))
				.filter(
					(f, i, all) => all.findIndex((o) => o.rendered === f.rendered) === i,
				);

			return {
				unit,
				scheme,
				key: owner === unit ? unit.id : `group:${owner.id}`,
				formats,
			};
		});

	const rendered = new Map<string, { key: string; id: string }>();
	for (const { unit, key, formats } of released) {
		for (const format of formats) {
			const other = rendered.get(format.rendered);
			if (other !== undefined && other.key !== key) {
				throw overlap([other.id, unit.id], { format: format.rendered });
			}

			rendered.set(format.rendered, { key, id: unit.id });
		}
	}

	const versionOf = (r: (typeof released)[number], tag: string) =>
		r.formats
			.map((f) => f.match(tag))
			.find((raw) => raw !== undefined && r.scheme.parse(raw) !== undefined);

	const matched = new Map(
		released.map((r): [string, UnitTags] => [
			r.unit.id,
			{ scheme: r.scheme, tags: [] },
		]),
	);
	for (const tag of tags) {
		const owners = released.filter((r) => versionOf(r, tag.name) !== undefined);
		if (new Set(owners.map((r) => r.key)).size > 1) {
			throw overlap(
				owners.map((r) => r.unit.id),
				{ tag: tag.name },
			);
		}

		for (const owner of owners) {
			const version = versionOf(owner, tag.name);
			if (version !== undefined) {
				matched.get(owner.unit.id)?.tags.push({ ...tag, version });
			}
		}
	}

	for (const { scheme, tags: list } of matched.values()) {
		list.sort(
			(a, b) =>
				scheme.compare(scheme.parse(a.version), scheme.parse(b.version)) ||
				compare(a.name, b.name),
		);
	}

	return matched;
};

/**
 * Released units without a matching tag while some tag not matched by a
 * released unit or a group's release tag contains their id, delimited by
 * non-alphanumeric characters or the tag's ends.
 */
export const noMatchingTag = (
	{ units, groups }: { units: readonly Unit[]; groups: readonly Group[] },
	matched: readonly { id: string; tags: readonly { name: string }[] }[],
	tagNames: readonly string[],
): Warning[] => {
	const ignore = groups.flatMap((g) =>
		g.releaseTag === null ? [] : [compileTagFormat(g.releaseTag, g.name)],
	);
	const names = new Set(matched.flatMap((m) => m.tags.map((t) => t.name)));
	const tags = tagNames.filter(
		(t) => !names.has(t) && !ignore.some((f) => f.match(t) !== undefined),
	);

	return matched.flatMap((m) => {
		const unit = units.find((u) => u.id === m.id);
		const id = new RegExp(
			`(?:^|[^A-Za-z0-9])${m.id.replace(SPECIAL, "\\$&")}(?:[^A-Za-z0-9]|$)`,
			"u",
		);
		const similar = tags.find((t) => id.test(t));
		if (!unit || m.tags.length > 0 || similar === undefined) {
			return [];
		}

		const owner = tagOwner(groups, unit);

		return [
			coreCodes.warning(
				"W_NO_MATCHING_TAG",
				`released unit "${m.id}" has no tag matching "${owner.tagFormat.replaceAll("{id}", owner.id)}", but "${similar}" contains its id`,
				{ unit: m.id },
			),
		];
	});
};
