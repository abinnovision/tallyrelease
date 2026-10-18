import lib from "semver";

import { coreCodes } from "./codes.js";

import type { VersionScheme } from "./plugin.js";

const format = (v: SemVer): string => {
	const pre = v.prerelease.length > 0 ? `-${v.prerelease.join(".")}` : "";
	const build = v.build.length > 0 ? `+${v.build.join(".")}` : "";

	return `${[v.major, v.minor, v.patch].join(".")}${pre}${build}`;
};

/** Strict: the input must be exactly its canonical form (no `v`, no padding). */
const parse = (raw: string): SemVer | undefined => {
	const parsed = lib.parse(raw);
	if (!parsed) {
		return undefined;
	}

	const v: SemVer = {
		major: parsed.major,
		minor: parsed.minor,
		patch: parsed.patch,
		prerelease: [...parsed.prerelease],
		build: [...parsed.build],
	};

	return format(v) === raw ? v : undefined;
};

const mustParse = (raw: string): SemVer => {
	const v = parse(raw);
	if (!v) {
		throw coreCodes.error("E_VERSION_INVALID", `invalid version "${raw}"`, {
			version: raw,
		});
	}

	return v;
};

const core = ({ major, minor, patch }: SemVer) => ({ major, minor, patch });

/** A parsed SemVer 2.0 version. */
export interface SemVer {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly prerelease: readonly (string | number)[];
	readonly build: readonly string[];
}

/** SemVer 2.0 scheme; bumps follow the `semver` package `inc`. */
export const semver: VersionScheme<SemVer> = {
	parse,
	format,
	compare: (a, b) => lib.compare(format(a), format(b)),
	core,
	isPrerelease: (v) => v.prerelease.length > 0,
	initial: () => ({ major: 1, minor: 0, patch: 0, prerelease: [], build: [] }),
	bump: (v, level) => mustParse(lib.inc(format(v), level) ?? ""),
	release: (next) => next,
	prerelease: (next, ctx) => {
		const { major, minor, patch } = core(next);
		const n = String(ctx.firstParent.sinceLineBase);
		const raw = `${[major, minor, patch].join(".")}-${ctx.channel}.${n}`;
		const v = parse(raw);
		if (!v) {
			throw coreCodes.error(
				"E_CHANNEL_INVALID",
				`channel "${ctx.channel}" does not form a valid prerelease`,
				{ channel: ctx.channel },
			);
		}

		return v;
	},
};
