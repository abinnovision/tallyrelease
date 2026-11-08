import { describe, expect, it } from "vitest";

import { semver } from "./semver.js";
import { compileTagFormat, matchUnitTags } from "./tags.js";

import type { Group } from "./groups.js";
import type { Unit } from "./plugin.js";

const unit = (id: string, tagFormat: string, released = true): Unit => ({
	id,
	root: id,
	plugin: "config",
	include: [],
	exclude: [],
	version: released ? "tag" : "none",
	scheme: "semver",
	tagFormat,
	propagate: "auto",
	tags: [],
	initialVersion: null,
	meta: {},
});

const schemes = new Map([["semver", semver]]);
const tag = (name: string) => ({ name, sha: "c0" });
const names = (units: Unit[], tags: string[], groups: Group[] = []) =>
	Object.fromEntries(
		[...matchUnitTags({ units, schemes, groups }, tags.map(tag))].map(
			([id, list]) => [id, list.tags.map((t) => t.name)],
		),
	);

describe("compileTagFormat", () => {
	it("escapes literal parts and the id", () => {
		const format = compileTagFormat("({id})+v{version}", "a.b");
		expect(format.rendered).toBe("(a.b)+v{version}");
		expect(format.match("(a.b)+v1.0.0")).toBe("1.0.0");
		expect(format.match("(aXb)+v1.0.0")).toBeUndefined();
		expect(format.match("(a.b)vv1.0.0")).toBeUndefined();
	});

	it("requires {version} exactly once", () => {
		for (const format of ["{id}-v", "{version}-{version}"]) {
			expect(() => compileTagFormat(format, "a")).toThrow(
				expect.objectContaining({ code: "E_TAG_FORMAT" }),
			);
		}
	});
});

describe("matchUnitTags", () => {
	it("matches released units only, sorted by scheme order", () => {
		expect(
			names(
				[unit("a", "v{version}"), unit("b", "v{version}", false)],
				["v1.10.0", "v1.9.0", "v1.10.0-rc.1", "vx"],
			),
		).toEqual({ a: ["v1.9.0", "v1.10.0-rc.1", "v1.10.0"] });
	});

	it("rejects a released unit with an unknown scheme", () => {
		expect(() =>
			names([{ ...unit("a", "v{version}"), scheme: "calver" }], []),
		).toThrow(
			expect.objectContaining({
				code: "E_SCHEME_UNKNOWN",
				details: { unit: "a", scheme: "calver" },
			}),
		);
	});

	it("rejects two released units with the same rendered format", () => {
		expect(() =>
			names([unit("a", "v{version}"), unit("b", "v{version}")], []),
		).toThrow(
			expect.objectContaining({
				code: "E_TAG_FORMAT_OVERLAP",
				details: { units: ["a", "b"], format: "v{version}" },
			}),
		);
	});

	it("gives members of a group with tagFormat the group tags and their own", () => {
		const group: Group = {
			name: "sdk",
			members: ["a", "b"],
			releaseTag: null,
			tagFormat: "v{version}",
		};
		expect(
			names(
				[unit("a", "{id}-v{version}"), unit("b", "{id}-v{version}")],
				["v1.1.0", "a-v1.0.0"],
				[group],
			),
		).toEqual({ a: ["a-v1.0.0", "v1.1.0"], b: ["v1.1.0"] });
	});
});
