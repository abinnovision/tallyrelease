import { validateBranches } from "./branches.js";
import { coreCodes } from "./codes.js";
import { validateFloating } from "./floating.js";
import { validateReleaseItems } from "./release-items.js";
import { assertSchemes } from "./schemes.js";
import {
	compileTagFormat,
	matchUnitTags,
	noMatchingTag,
	renderTag,
} from "./tags.js";
import { uniqueSorted } from "./util.js";
import { validateTemplates } from "./version-files.js";

import type { Warning } from "./errors.js";
import type { TagRef } from "./plugin.js";
import type { Workspace } from "./workspace.js";

const TOKEN = /\{([^{}]*)\}/gu;

/**
 * Group release tags and tag formats: `E_CONFIG` when a group sets both or
 * for a token other than `{id}` and `{version}`, `E_TAG_FORMAT` unless
 * `{version}` occurs once, `E_GROUP_OWN_TAGS` for a member with `ownTags` in a
 * group with `tagFormat` and `E_TAG_FORMAT_OVERLAP` when another group's
 * format renders the same or a released unit's tag format or another group's
 * `tagFormat` parses a sample tag of the group: the initial version of the
 * members' scheme and, when the scheme parses it, that version with `-rc.1`.
 * Members are exempt for their group's `tagFormat`.
 */
const validateReleaseTags = (workspace: Workspace): void => {
	const units = new Map(workspace.units.map((u) => [u.id, u]));
	const schemeOf = (id: string | undefined) =>
		workspace.schemes.get(units.get(id ?? "")?.scheme ?? "");
	// Formats planning parses: released units and groups with `tagFormat`.
	const parsed = [
		...workspace.units
			.filter((u) => u.version !== "none")
			.map((u) => ({
				label: `unit "${u.id}"`,
				detail: { unit: u.id },
				exempt: (group: string) =>
					workspace.groups.some(
						(g) =>
							g.name === group &&
							g.tagFormat !== null &&
							g.members.includes(u.id),
					),
				format: compileTagFormat(u.tagFormat, u.id),
				scheme: workspace.schemes.get(u.scheme),
			})),
		...workspace.groups.flatMap((g) =>
			g.tagFormat === null || g.tagFormat.split("{version}").length !== 2
				? []
				: [
						{
							label: `group "${g.name}"`,
							detail: { other: g.name },
							exempt: (group: string) => group === g.name,
							format: compileTagFormat(g.tagFormat, g.name),
							scheme: schemeOf(g.members[0]),
						},
					],
		),
	];
	const groups = new Map<string, string>();
	for (const { name, members, releaseTag, tagFormat } of workspace.groups) {
		if (releaseTag !== null && tagFormat !== null) {
			throw coreCodes.error(
				"E_CONFIG",
				`group "${name}" sets both releaseTag and tagFormat; use one`,
				{ group: name },
			);
		}

		const ownTags =
			tagFormat === null
				? undefined
				: members.find((id) => units.get(id)?.ownTags === true);
		if (ownTags !== undefined) {
			throw coreCodes.error(
				"E_GROUP_OWN_TAGS",
				`unit "${ownTags}" of group "${name}" needs its own tags; group tagFormat cannot replace them`,
				{ group: name, unit: ownTags },
			);
		}

		const [label, format] =
			tagFormat === null
				? ["release tag", releaseTag]
				: ["tag format", tagFormat];
		if (format === null) {
			continue;
		}

		const unknown = [...format.matchAll(TOKEN)].find(
			([, token]) => token !== "id" && token !== "version",
		);
		if (unknown) {
			throw coreCodes.error(
				"E_CONFIG",
				`${label} "${format}" of group "${name}" uses unknown token "${unknown[0]}"; use {id} or {version}`,
				{ group: name, format },
			);
		}

		if (format.split("{version}").length !== 2) {
			throw coreCodes.error(
				"E_TAG_FORMAT",
				`${label} "${format}" of group "${name}" must contain {version} exactly once`,
				{ group: name, format },
			);
		}

		const rendered = format.replaceAll("{id}", name);
		const other = groups.get(rendered);
		if (other !== undefined) {
			throw coreCodes.error(
				"E_TAG_FORMAT_OVERLAP",
				`${label} "${rendered}" of group "${name}" renders like the tags of group "${other}"`,
				{ group: name, format: rendered },
			);
		}

		groups.set(rendered, name);

		const scheme = schemeOf(members[0]);
		if (!scheme) {
			continue;
		}

		const initial = scheme.format(scheme.initial());
		const samples = [initial, `${initial}-rc.1`]
			.filter((v) => scheme.parse(v) !== undefined)
			.map((v) => renderTag({ id: name, tagFormat: format }, v));
		const clash = parsed.find(
			({ exempt, format: f, scheme: s }) =>
				!exempt(name) &&
				samples.some((tag) => {
					const raw = f.match(tag);

					return raw !== undefined && s?.parse(raw) !== undefined;
				}),
		);
		if (clash) {
			throw coreCodes.error(
				"E_TAG_FORMAT_OVERLAP",
				`${label} "${rendered}" of group "${name}" renders tags that match the tag format of ${clash.label}`,
				{ group: name, format: rendered, ...clash.detail },
			);
		}
	}
};

/**
 * Release-only checks, never run by `affected`: scheme registry, schemes, tag
 * formats and initial versions of released units, group members and release
 * tags, branch rules, their absolute check targets and channels, release
 * items, floating tag formats and version file templates.
 */
export const validateRelease = (workspace: Workspace): void => {
	const { schemes } = workspace;
	assertSchemes(schemes);
	for (const unit of workspace.units) {
		if (unit.version === "none") {
			continue;
		}

		const scheme = schemes.get(unit.scheme);
		if (!scheme) {
			throw coreCodes.error(
				"E_SCHEME_UNKNOWN",
				`unit "${unit.id}" uses unknown scheme "${unit.scheme}"`,
				{ unit: unit.id, scheme: unit.scheme },
			);
		}

		compileTagFormat(unit.tagFormat, unit.id);
		if (
			unit.initialVersion !== null &&
			scheme.parse(unit.initialVersion) === undefined
		) {
			throw coreCodes.error(
				"E_INITIAL_VERSION",
				`initial version "${unit.initialVersion}" of unit "${unit.id}" is not a ${unit.scheme} version`,
				{ unit: unit.id, version: unit.initialVersion },
			);
		}
	}

	const units = new Map(workspace.units.map((u) => [u.id, u]));
	for (const { name, members } of workspace.groups) {
		const unreleased = members.find((id) => units.get(id)?.version === "none");
		if (unreleased !== undefined) {
			throw coreCodes.error(
				"E_GROUP_NOT_RELEASED",
				`group "${name}" names unit "${unreleased}", which is not released`,
				{ group: name, unit: unreleased },
			);
		}

		const schemeNames = uniqueSorted(
			members.map((id) => units.get(id)?.scheme ?? ""),
		);
		if (schemeNames.length > 1) {
			throw coreCodes.error(
				"E_GROUP_SCHEME",
				`members of group "${name}" use different schemes: ${schemeNames.join(", ")}`,
				{ group: name, schemes: schemeNames },
			);
		}
	}

	validateReleaseTags(workspace);
	validateBranches(workspace.release.branches);
	const groupOf = new Map(
		workspace.groups.flatMap((g) => g.members.map((id) => [id, g.name])),
	);
	for (const rule of workspace.release.branches) {
		const { unit, group } = rule;
		const problem =
			unit !== null
				? units.get(unit)?.version === "none" || !units.has(unit)
					? `names unit "${unit}", which is not a released unit`
					: groupOf.has(unit)
						? `names unit "${unit}" of group "${groupOf.get(unit) ?? ""}"; use group`
						: undefined
				: group !== null && !workspace.groups.some((g) => g.name === group)
					? `names unknown group "${group}"`
					: undefined;
		if (problem !== undefined) {
			throw coreCodes.error(
				"E_BRANCH_RULE",
				`branch rule "${rule.name}" ${problem}`,
				{
					rule: rule.name,
					...(unit === null ? { group } : { unit }),
				},
			);
		}
	}

	validateReleaseItems(workspace);
	validateFloating(workspace.release.floating);
	validateTemplates(workspace);
};

/**
 * Checks `tags` against the released units: throws `E_TAG_FORMAT_OVERLAP`,
 * returns `W_NO_MATCHING_TAG` warnings.
 */
export const validateTags = (
	workspace: Workspace,
	tags: readonly TagRef[],
): Warning[] => {
	const matched = matchUnitTags(workspace, tags);

	return noMatchingTag(
		workspace,
		[...matched].map(([id, m]) => ({ id, tags: m.tags })),
		uniqueSorted(tags.map((t) => t.name)),
	);
};
