import { describe, expect, it } from "vitest";

import { flutter } from "./fixtures/flutter.js";
import { corePlugin } from "../src/builtin.js";
import { loadWorkspace } from "../src/index.js";
import { PLUGIN_API_VERSION } from "../src/plugin.js";
import { assertSchemes, schemeRegistry } from "../src/schemes.js";
import { semver } from "../src/semver.js";
import { memoryFs } from "../src/testing/index.js";

import type { Plugin } from "../src/plugin.js";

const plugin = (
	name: string,
	schemes: NonNullable<Plugin["schemes"]>,
): Plugin => ({ apiVersion: PLUGIN_API_VERSION, name, schemes });

describe("schemes", () => {
	it("maps names to schemes in plugin order", () => {
		const registry = schemeRegistry([corePlugin, plugin("dart", { flutter })]);
		expect([...registry]).toEqual([
			["semver", semver],
			["flutter", flutter],
		]);
		expect(() => {
			assertSchemes(registry);
		}).not.toThrow();
	});

	it("records a duplicate name, including reserved semver", () => {
		const reserved = schemeRegistry([
			corePlugin,
			plugin("x", { semver: flutter }),
		]);
		expect(reserved.get("semver")).toBe(semver);
		expect(() => {
			assertSchemes(reserved);
		}).toThrow(expect.objectContaining({ code: "E_SCHEME_CLASH" }));
		expect(() => {
			assertSchemes(
				schemeRegistry([plugin("a", { flutter }), plugin("b", { flutter })]),
			);
		}).toThrow(
			expect.objectContaining({
				code: "E_SCHEME_CLASH",
				details: { scheme: "flutter", plugins: ["a", "b"] },
			}),
		);
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
		await expect(load([plugin("core", {})])).rejects.toThrow(
			expect.objectContaining({ code: "E_PLUGIN_NAME" }),
		);
	});

	it("exposes schemes and intent sources, core first", async () => {
		const source = { name: "changesets", collect: () => [] };
		const dart = { ...plugin("dart", { flutter }), intent: [source] };
		const workspace = await load([dart]);
		expect([...workspace.schemes.keys()]).toEqual(["semver", "flutter"]);
		expect(workspace.intents.map((i) => [i.plugin, i.source.name])).toEqual([
			["core", "conventional-commits"],
			["dart", "changesets"],
		]);
	});
});
