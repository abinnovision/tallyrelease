import { describe, expect, it } from "vitest";

import { matchBranch, validateBranches } from "./branches.js";

import type { BranchRule } from "./model/branch-types.js";

const rule = (
	name: string,
	build: string | null = null,
	line: BranchRule["line"] = "maintenance",
	extra: Partial<Pick<BranchRule, "unit" | "group" | "channel" | "cut">> = {},
): BranchRule => ({
	name,
	line,
	channel: null,
	build,
	cut: null,
	unit: null,
	group: null,
	...extra,
});

const code = (rules: BranchRule[]) => {
	try {
		validateBranches(rules);

		return undefined;
	} catch (error) {
		return (error as { code?: string }).code;
	}
};

describe("validateBranches", () => {
	it.each([
		[[rule("release/{major}.x", "rc-{major}")], undefined],
		[[rule("release/{patch}.x")], "E_BRANCH_RULE"],
		[[rule("release/{major}.{major}")], "E_BRANCH_RULE"],
		[[rule("release/{minor}.x")], "E_BRANCH_RULE"],
		[[rule("release/{major.x")], "E_BRANCH_RULE"],
		[[rule("feature/*", "dev")], "E_CHANNEL_WILDCARD"],
		[[rule("main", "beta.1")], "E_CHANNEL_INVALID"],
		[[rule("release/{major}.x", "rc-{minor}")], "E_CHANNEL_INVALID"],
		[[rule("a", "rc"), rule("b", "rc")], "E_CHANNEL_DUPLICATE"],
		[[rule("release/{major}.x", "{major}")], "E_CHANNEL_INVALID"],
		[[rule("main", "1")], "E_CHANNEL_INVALID"],
		[[rule("main", null, "default", { cut: "beta.1" })], "E_CHANNEL_INVALID"],
		[
			[rule("feature/*", null, "default", { cut: "dev" })],
			"E_CHANNEL_WILDCARD",
		],
		[[rule("main", "beta", "default", { cut: "beta" })], "E_CHANNEL_DUPLICATE"],
		[
			[rule("a", "rc"), rule("b", null, "maintenance", { cut: "rc" })],
			"E_CHANNEL_DUPLICATE",
		],
		[[rule("main", "beta", "default", { channel: "beta" })], "E_CONFIG"],
		[[rule("main", null, "default", { channel: "a", cut: "b" })], undefined],
		[
			[rule("release/{major}.x", null, "maintenance", { unit: "a" })],
			undefined,
		],
		[
			[
				rule("release/{major}.x", null, "maintenance", {
					unit: "a",
					group: "g",
				}),
			],
			"E_BRANCH_RULE",
		],
		[[rule("release/*", null, "maintenance", { group: "g" })], "E_BRANCH_RULE"],
		[[rule("main", null, "default", { unit: "a" })], "E_BRANCH_RULE"],
	])("%j: %s", (rules, expected) => {
		expect(code(rules)).toBe(expected);
	});
});

describe("matchBranch", () => {
	it("maps the channel alias to the build channel and renders the cut channel", () => {
		const rules = [
			rule("release/{major}.x", null, "maintenance", {
				channel: "a-{major}",
				cut: "rc-{major}",
			}),
		];
		expect(matchBranch(rules, "release/2.x")).toMatchObject({
			channel: "a-2",
			cut: "rc-2",
		});
	});

	it("returns the first matching rule with rendered channel and max bump", () => {
		const rules = [
			rule("main", "beta", "default"),
			rule("release/{major}.{minor}.x", "rc-{major}-{minor}"),
			rule("release/*"),
		];
		expect(matchBranch(rules, "release/2.3.x")).toEqual({
			rule: "release/{major}.{minor}.x",
			kind: "maintenance",
			channel: "rc-2-3",
			cut: null,
			maxBump: "patch",
			absolute: null,
		});
		expect(matchBranch(rules, "release/a/b")).toMatchObject({
			rule: "release/*",
			maxBump: null,
		});
		expect(matchBranch(rules, "mainline")).toBeNull();
		expect(matchBranch(rules, "release/01.2.x")).toMatchObject({
			rule: "release/*",
		});
	});
});
