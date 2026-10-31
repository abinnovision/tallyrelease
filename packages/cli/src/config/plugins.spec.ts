import { describe, expect, it } from "vitest";

import { resolvePlugins } from "./plugins.js";
import { configSchema } from "./schema.js";

const local = { apiVersion: 1, name: "local" };

const resolve = async (plugins: unknown, exports: unknown = local) => {
	const imported: string[] = [];
	const result = await resolvePlugins(
		configSchema.parse({ plugins }),
		(path) => {
			imported.push(path);

			return Promise.resolve(exports);
		},
	);

	return { ...result, imported };
};

describe("resolvePlugins", () => {
	it("loads path plugins and strips path from the config", async () => {
		const { config, plugins, imported } = await resolve({
			node: null,
			local: { path: "./tools/plugin.ts", globalInputs: false, x: 1 },
		});

		expect(config.plugins).toEqual({
			node: null,
			local: { globalInputs: false, x: 1 },
		});
		expect(plugins.at(-1)).toBe(local);
		expect(imported).toEqual(["./tools/plugin.ts"]);
	});

	it("imports package plugins by name", async () => {
		const { config, imported } = await resolve({
			local: { package: "@acme/tallyrelease-plugin-local" },
		});

		expect(config.plugins).toEqual({ local: {} });
		expect(imported).toEqual(["@acme/tallyrelease-plugin-local"]);
	});

	it.each([
		[{ node: { path: "p.ts" } }, local, "a built-in plugin cannot set path"],
		[{ php: { package: "x" } }, local, "a built-in plugin cannot set package"],
		[{ local: { path: "../p.ts" } }, local, "outside the repository root"],
		[{ local: { path: "/p.ts" } }, local, "outside the repository root"],
		[{ local: { path: "p.ts" } }, { name: "other" }, 'named "local"'],
		[{ local: { path: "p.ts" } }, null, 'named "local"'],
	])("rejects %j with E_PLUGIN_LOAD", async (plugins, exports, message) => {
		await expect(resolve(plugins, exports)).rejects.toMatchObject({
			code: "E_PLUGIN_LOAD",
			message: expect.stringContaining(message),
		});
	});

	it("wraps import failures as E_PLUGIN_LOAD", async () => {
		await expect(
			resolvePlugins(
				configSchema.parse({ plugins: { local: { path: "p.ts" } } }),
				() => Promise.reject(new Error("boom")),
			),
		).rejects.toMatchObject({
			code: "E_PLUGIN_LOAD",
			message: 'plugin "local": cannot load "p.ts": boom',
		});
	});
});
