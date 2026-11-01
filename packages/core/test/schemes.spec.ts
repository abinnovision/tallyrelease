import { describe, expect, it } from "vitest";

import { corePlugin } from "../src/builtin.js";
import { calver } from "../src/calver.js";
import { loadWorkspace } from "../src/index.js";
import { PLUGIN_API_VERSION } from "../src/plugin.js";
import { assertSchemes, schemeRegistry } from "../src/schemes.js";
import { semver } from "../src/semver.js";
import { flutter } from "./fixtures/flutter.js";
import { schemeConformance } from "../src/testing/conformance.js";
import { memoryFs } from "../src/testing/index.js";

import type { Plugin } from "../src/plugin.js";

const plugin = (
	name: string,
	schemes: NonNullable<Plugin["schemes"]>,
): Plugin => ({ apiVersion: PLUGIN_API_VERSION, name, schemes });

describe("semver", () => {
	schemeConformance(semver);
});

describe("calver", () => {
	schemeConformance(calver, { dateDriven: true });
});

describe("flutter", () => {
	schemeConformance(flutter);
});

describe("schemes", () => {
	it("maps names to schemes in plugin order", () => {
		const registry = schemeRegistry([corePlugin, plugin("dart", { flutter })]);
		expect([...registry]).toEqual([
			["semver", semver],
			["calver", calver],
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

	it("uses the highest tagged build plus one", () => {
		const v = flutter.parse("1.2.3+0");
		const unit = {
			id: "app",
			root: ".",
			plugin: "dart",
			include: [],
			exclude: [],
			version: "file" as const,
			scheme: "flutter",
			tagFormat: "v{version}",
			propagate: "auto" as const,
			tags: [],
			initialVersion: null,
			meta: {},
		};
		const ctx = {
			unit,
			head: "h",
			baseTag: null,
			tags: ["v1.2.2+7"],
			firstParent: { sinceLineBase: 1, total: 3 },
		};
		expect(v && flutter.format(flutter.release(v, ctx))).toBe("1.2.3+8");
		const tags = ["app2-v1.2.2+500"];
		expect(v && flutter.format(flutter.release(v, { ...ctx, tags }))).toBe(
			"1.2.3+501",
		);
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
		expect([...workspace.schemes.keys()]).toEqual([
			"semver",
			"calver",
			"flutter",
		]);
		expect(workspace.intents.map((i) => [i.plugin, i.source.name])).toEqual([
			["core", "conventional-commits"],
			["dart", "changesets"],
		]);
	});
});
