import { describe, expect, it } from "vitest";

import { resolveAttribution, scopedUnits, scopeUnits } from "./attribution.js";

import type { Unit } from "./plugin.js";

const units = ["a", "b", "c"].map((id): Unit => ({
	id,
	root: id,
	plugin: "config",
	include: [],
	exclude: [],
	version: "tag",
	scheme: "semver",
	tagFormat: "{id}-v{version}",
	propagate: "auto",
	tags: [],
	initialVersion: null,
	meta: {},
}));
const paths = resolveAttribution(units, {
	scopes: { api: ["b"], ui: ["c", "c"] },
});
const narrow = { ...paths, mode: "narrow" as const };

describe("scopeUnits", () => {
	it.each([
		["fix: x", []],
		["fix(other): x", []],
		["fix(api): x", ["b"]],
		["fix(API): x", []],
		["fix( ui , api ): x", ["b", "c"]],
		["fix(api,other): x", ["b"]],
		["fix: x\n\nfix(api): body", []],
	])("maps %j to %j", (message, expected) => {
		expect(scopeUnits(paths, message)).toEqual(expected);
	});

	it("maps nothing without scopes", () => {
		expect(scopeUnits(resolveAttribution(units, {}), "fix(api): x")).toEqual(
			[],
		);
	});
});

describe("scopedUnits", () => {
	it.each([
		[paths, ["a"], [], ["a"]],
		[narrow, ["a"], [], ["a"]],
		[paths, ["c"], ["b"], ["b", "c"]],
		[narrow, ["c"], ["b"], ["b"]],
		[paths, [], ["b"], ["b"]],
		[narrow, [], ["b"], ["b"]],
	])("%#", (rules, owners, scoped, expected) => {
		expect(scopedUnits(rules, owners, scoped)).toEqual(expected);
	});
});

describe("resolveAttribution", () => {
	it("dedupes targets and defaults to paths", () => {
		expect(paths).toEqual({
			mode: "paths",
			scopes: new Map([
				["api", ["b"]],
				["ui", ["c"]],
			]),
		});
	});

	it("reports the first unknown unit by sorted scope, then list order", () => {
		expect(() =>
			resolveAttribution(units, {
				scopes: { zz: ["gone"], api: ["a", "nope", "x"] },
			}),
		).toThrow(
			expect.objectContaining({
				code: "E_ATTRIBUTION_UNKNOWN_UNIT",
				details: { scope: "api", unit: "nope" },
			}),
		);
	});
});
