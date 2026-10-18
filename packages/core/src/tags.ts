import { coreCodes } from "./codes.js";
import { compare } from "./util.js";

import type { Warning } from "./errors.js";
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

/** Tags of a released unit and its scheme. */
export interface UnitTags {
	readonly scheme: VersionScheme<any>;
	/** Sorted by scheme order, then name. */
	readonly tags: UnitTag[];
}

/**
 * Tags of each released unit, sorted by scheme order, then name. Unreleased
 * units never match. Throws `E_TAG_FORMAT_OVERLAP` if two released units render
 * the same format or a tag parses for more than one of them.
 */
export const matchUnitTags = (
	units: readonly Unit[],
	tags: readonly TagRef[],
	schemes: ReadonlyMap<string, VersionScheme<any>>,
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

			return {
				unit,
				scheme,
				format: compileTagFormat(unit.tagFormat, unit.id),
			};
		});

	const rendered = new Map<string, string>();
	for (const { unit, format } of released) {
		const other = rendered.get(format.rendered);
		if (other !== undefined) {
			throw overlap([other, unit.id], { format: format.rendered });
		}

		rendered.set(format.rendered, unit.id);
	}

	const matched = new Map(
		released.map((r): [string, UnitTags] => [
			r.unit.id,
			{ scheme: r.scheme, tags: [] },
		]),
	);
	for (const tag of tags) {
		const owners = released.filter((r) => {
			const raw = r.format.match(tag.name);

			return raw !== undefined && r.scheme.parse(raw) !== undefined;
		});
		if (owners.length > 1) {
			throw overlap(
				owners.map((r) => r.unit.id),
				{ tag: tag.name },
			);
		}

		const [owner] = owners;
		const version = owner?.format.match(tag.name);
		if (owner && version !== undefined) {
			matched.get(owner.unit.id)?.tags.push({ ...tag, version });
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
 * released unit contains their id, delimited by non-alphanumeric characters
 * or the tag's ends.
 */
export const noMatchingTag = (
	units: readonly Unit[],
	matched: readonly { id: string; tags: readonly { name: string }[] }[],
	tagNames: readonly string[],
): Warning[] => {
	const names = new Set(matched.flatMap((m) => m.tags.map((t) => t.name)));
	const tags = tagNames.filter((t) => !names.has(t));

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

		return [
			coreCodes.warning(
				"W_NO_MATCHING_TAG",
				`released unit "${m.id}" has no tag matching "${unit.tagFormat.replaceAll("{id}", m.id)}", but "${similar}" contains its id`,
				{ unit: m.id },
			),
		];
	});
};
