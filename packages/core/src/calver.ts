import { semver } from "./semver.js";

import type { PreCtx, VersionScheme } from "./plugin.js";
import type { SemVer } from "./semver.js";

/** Year and month of `ctx.date` in UTC. */
const monthOf = (ctx: PreCtx): { year: number; month: number } => {
	if (ctx.date === undefined) {
		throw new Error(
			"calver needs the commit date; the git reader does not provide commitDate",
		);
	}

	const date = Date.parse(ctx.date);
	if (Number.isNaN(date)) {
		throw new Error(`calver cannot parse the commit date "${ctx.date}"`);
	}

	const utc = new Date(date);

	return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1 };
};

/** `next`, or `Y.M.0` of the commit date when that month is newer. */
const release = (next: SemVer, ctx: PreCtx): SemVer => {
	const { year, month } = monthOf(ctx);
	const newer =
		year > next.major || (year === next.major && month > next.minor);

	return newer
		? { major: year, minor: month, patch: 0, prerelease: [], build: [] }
		: next;
};

/**
 * Calendar versions `Y.M.N` with SemVer syntax: every bump increments `N`,
 * releasing moves to `Y.M.0` of the planned commit's UTC date when that
 * month is newer.
 */
export const calver: VersionScheme<SemVer> = {
	...semver,
	parse: (raw) => {
		const v = semver.parse(raw);

		return v && v.build.length === 0 ? v : undefined;
	},
	initial: () => ({ major: 0, minor: 0, patch: 0, prerelease: [], build: [] }),
	bump: (v) => semver.bump(v, "patch"),
	release,
	prerelease: (next, ctx) => semver.prerelease(release(next, ctx), ctx),
};
