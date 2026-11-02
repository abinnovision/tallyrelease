import { coreCodes } from "./codes.js";

import type { Warning } from "./errors.js";
import type { GitReader } from "./plugin.js";
import type { Workspace } from "./workspace.js";

/**
 * Build number of each target: the first-parent commit count of `sha` plus
 * the unit's `buildNumber.offset`, null for a unit without `buildNumber`. On a
 * maintenance line, warns once per target unit with `buildNumber`.
 */
export const buildNumbers = async (
	workspace: Workspace,
	targets: readonly { id: string; sha: string }[],
	{ git, line }: { git: GitReader; line: "default" | "maintenance" },
): Promise<{ numbers: (number | null)[]; warnings: Warning[] }> => {
	const offsets = new Map(
		workspace.units.flatMap((u) =>
			u.buildNumber ? [[u.id, u.buildNumber.offset] as const] : [],
		),
	);
	const counts = new Map<string, Promise<number>>();
	const count = async (sha: string): Promise<number> => {
		let counted = counts.get(sha);
		if (counted === undefined) {
			counted = Promise.resolve(git.countFirstParent(null, sha));
			counts.set(sha, counted);
		}

		return await counted;
	};

	const numbers = await Promise.all(
		targets.map(async ({ id, sha }) => {
			const offset = offsets.get(id);

			return offset === undefined ? null : (await count(sha)) + offset;
		}),
	);
	const warned = line === "maintenance" ? targets.map((t) => t.id) : [];

	return {
		numbers,
		warnings: [...new Set(warned)]
			.filter((id) => offsets.has(id))
			.map((id) =>
				coreCodes.warning(
					"W_BUILD_NUMBER_MAINTENANCE",
					`unit "${id}" is on a maintenance line; its build numbers can repeat numbers already uploaded from the default branch`,
					{ unit: id },
				),
			),
	};
};
