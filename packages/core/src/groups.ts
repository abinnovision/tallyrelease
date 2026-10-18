import { coreCodes } from "./codes.js";
import { compare, uniqueSorted } from "./util.js";

import type { GroupConfig } from "./config.js";
import type { Warning } from "./errors.js";
import type { Unit } from "./plugin.js";

/** A fixed group: its members release together with one version. */
export interface Group {
	readonly name: string;
	/** Sorted unit ids. */
	readonly members: readonly string[];
}

/**
 * Resolves group members: `units` by id, `tags` to released units with any of
 * the tags. Throws `E_GROUP_UNKNOWN_UNIT` and `E_GROUP_OVERLAP`; a group
 * selecting nothing warns `W_GROUP_EMPTY` and is dropped.
 */
export const resolveGroups = (
	units: readonly Unit[],
	config: Readonly<Record<string, GroupConfig>> | undefined,
	warnings: Warning[],
): Group[] => {
	const known = new Set(units.map((u) => u.id));
	const owner = new Map<string, string>();
	const groups: Group[] = [];
	for (const name of Object.keys(config ?? {}).sort(compare)) {
		const { units: ids = [], tags = [] } = config?.[name] ?? {};
		const unknown = ids.find((id) => !known.has(id));
		if (unknown !== undefined) {
			throw coreCodes.error(
				"E_GROUP_UNKNOWN_UNIT",
				`group "${name}" names unknown unit "${unknown}"`,
				{ group: name, unit: unknown },
			);
		}

		const members = uniqueSorted([
			...ids,
			...units
				.filter(
					(u) => u.version !== "none" && u.tags.some((t) => tags.includes(t)),
				)
				.map((u) => u.id),
		]);
		if (members.length === 0) {
			warnings.push(
				coreCodes.warning("W_GROUP_EMPTY", `group "${name}" selects no unit`),
			);
			continue;
		}

		for (const id of members) {
			const other = owner.get(id);
			if (other !== undefined) {
				throw coreCodes.error(
					"E_GROUP_OVERLAP",
					`unit "${id}" is in groups "${other}" and "${name}"`,
					{ unit: id, groups: [other, name] },
				);
			}

			owner.set(id, name);
		}

		groups.push({ name, members });
	}

	return groups;
};
