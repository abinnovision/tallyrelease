import { describe, expect, it } from "vitest";

import { flutter } from "./fixtures/flutter.js";
import { loadWorkspace } from "../src/index.js";
import { PLUGIN_API_VERSION } from "../src/plugin.js";
import { collectSchemes, schemeRegistry } from "../src/schemes.js";
import { semver } from "../src/semver.js";
import { memoryFs } from "../src/testing/index.js";

import type { Plugin } from "../src/plugin.js";

const plugin = (name: string, schemes: NonNullable<Plugin["schemes"]>) => {
	const p: Plugin = { apiVersion: PLUGIN_API_VERSION, name, schemes };

	return { plugin: p };
};

describe("schemes", () => {
	it("collects core semver first, then plugin schemes", () => {
		const list = collectSchemes([plugin("dart", { flutter })]);
		expect(list).toEqual([
			{ plugin: "core", name: "semver", scheme: semver },
			{ plugin: "dart", name: "flutter", scheme: flutter },
		]);
		expect(schemeRegistry(list).get("flutter")).toBe(flutter);
	});

	it("rejects a duplicate name, including reserved semver", () => {
		expect(() =>
			schemeRegistry(collectSchemes([plugin("x", { semver: flutter })])),
		).toThrow(expect.objectContaining({ code: "E_SCHEME_CLASH" }));
		expect(() =>
			schemeRegistry(
				collectSchemes([plugin("a", { flutter }), plugin("b", { flutter })]),
			),
		).toThrow(expect.objectContaining({ code: "E_SCHEME_CLASH" }));
	});

	it("round-trips a flutter version", () => {
		const v = flutter.parse("1.2.3+45");
		expect(v && flutter.format(v)).toBe("1.2.3+45");
		expect(v && flutter.format(flutter.bump(v, "minor"))).toBe("1.3.0+45");
		expect(flutter.parse("1.2.3")).toBeUndefined();
	});
});

describe("loadWorkspace", () => {
	const load = (plugins: Plugin[]) =>
		loadWorkspace({
			config: {
				plugins: Object.fromEntries(plugins.map((p) => [p.name, null])),
			},
			plugins,
			fs: memoryFs({}),
			repo: { name: "demo" },
		});

	it("reserves the plugin name core", async () => {
		await expect(load([plugin("core", {}).plugin])).rejects.toThrow(
			expect.objectContaining({ code: "E_PLUGIN_NAME" }),
		);
	});

	it("exposes schemes and intent sources, core first", async () => {
		const source = { name: "changesets", collect: () => [] };
		const dart = { ...plugin("dart", { flutter }).plugin, intent: [source] };
		const workspace = await load([dart]);
		expect(workspace.schemes.map((s) => s.name)).toEqual(["semver", "flutter"]);
		expect(workspace.intents.map((i) => [i.plugin, i.source.name])).toEqual([
			["core", "conventional-commits"],
			["dart", "changesets"],
		]);
	});
});
