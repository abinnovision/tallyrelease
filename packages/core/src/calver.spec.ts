import { describe, expect, it } from "vitest";

import { calver } from "./calver.js";

import type { PreCtx, Unit } from "./plugin.js";

const v = (raw: string) => {
	const parsed = calver.parse(raw);
	if (!parsed) {
		throw new Error(`not a version: ${raw}`);
	}

	return parsed;
};

const unit: Unit = {
	id: "a",
	root: "a",
	plugin: "config",
	include: [],
	exclude: [],
	version: "tag",
	scheme: "calver",
	tagFormat: "{id}-v{version}",
	propagate: "auto",
	tags: [],
	initialVersion: null,
	meta: {},
};

const ctx = (date?: string): PreCtx => ({
	unit,
	head: "abc",
	...(date === undefined ? {} : { date }),
	baseTag: null,
	tags: [],
	firstParent: { sinceLineBase: 2, total: 10 },
});

const release = (next: string, date: string) =>
	calver.format(calver.release(v(next), ctx(date)));

describe("calver", () => {
	it("parses Y.M.N without leading zeros or build metadata", () => {
		expect(calver.core(v("2026.11.0"))).toEqual({
			major: 2026,
			minor: 11,
			patch: 0,
		});
		for (const raw of ["2026.01.0", "v2026.11.0", "2026.11", "2026.11.0+1"]) {
			expect(calver.parse(raw)).toBeUndefined();
		}
	});

	it("bumps N for every level", () => {
		for (const level of ["major", "minor", "patch"] as const) {
			expect(calver.format(calver.bump(v("2026.10.3"), level))).toBe(
				"2026.10.4",
			);
		}
	});

	it("moves to Y.M.0 of a newer UTC commit month only", () => {
		expect(release("2026.10.1", "2026-10-31T23:00:00Z")).toBe("2026.10.1");
		expect(release("2026.10.1", "2026-11-01T00:00:00Z")).toBe("2026.11.0");
		expect(release("2026.10.1", "2027-01-05T00:00:00Z")).toBe("2027.1.0");
		expect(release("2026.10.1", "2026-09-30T00:00:00Z")).toBe("2026.10.1");
		expect(release("2026.10.1", "2026-11-01T01:00:00+02:00")).toBe("2026.10.1");
	});

	it("prereleases the released Y.M.N", () => {
		expect(
			calver.format(
				calver.prerelease(v("2026.10.1"), {
					...ctx("2026-11-02T00:00:00Z"),
					channel: "rc",
				}),
			),
		).toBe("2026.11.0-rc.2");
	});

	it("needs the commit date", () => {
		expect(() => calver.release(v("2026.10.1"), ctx())).toThrow(
			"calver needs the commit date; the git reader does not provide commitDate",
		);
		expect(() =>
			calver.prerelease(v("2026.10.1"), { ...ctx(), channel: "rc" }),
		).toThrow("calver needs the commit date");
	});
});
