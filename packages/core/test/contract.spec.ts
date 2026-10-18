import { describe, expect, it } from "vitest";

import { defaultUnitId, definePlugin } from "../src/index.js";
import { memoryCtx, memoryFs } from "../src/testing/index.js";

describe("definePlugin", () => {
	it("returns a valid plugin unchanged", () => {
		const plugin = { apiVersion: 1, name: "node-x" } as const;

		expect(definePlugin(plugin)).toBe(plugin);
	});

	it("rejects an invalid name", () => {
		expect(() => definePlugin({ apiVersion: 1, name: "Node" })).toThrow(
			expect.objectContaining({ code: "E_PLUGIN_NAME" }),
		);
	});
});

describe("defaultUnitId", () => {
	it("uses the repo name for the root and the basename otherwise", () => {
		expect(defaultUnitId(".", "demo")).toBe("demo");
		expect(defaultUnitId("packages/ui", "demo")).toBe("ui");
	});
});

describe("memoryFs", () => {
	const fs = memoryFs({
		"package.json": "{}",
		"packages/a/package.json": "{}",
		"packages/a/node_modules/x/package.json": "{}",
		"packages/b/src/index.ts": "",
		"packages/b/vendor/package.json": "{}",
		"vendor/x/package.json": "{}",
	});

	it("reads files and checks paths", () => {
		expect(fs.read("package.json")).toBe("{}");
		expect(fs.read("missing")).toBeUndefined();
		expect(fs.exists("packages/b/src")).toBe(true);
		expect(fs.exists("packages/c")).toBe(false);
	});

	it("globs files and directories, skipping node_modules and top-level vendor", () => {
		expect(fs.glob(["**/package.json"])).toEqual([
			"package.json",
			"packages/a/package.json",
			"packages/b/vendor/package.json",
		]);
		expect(fs.glob(["packages/*"], { dirs: true })).toEqual([
			"packages/a",
			"packages/b",
		]);
	});
});

describe("memoryCtx", () => {
	it("collects warnings", () => {
		const ctx = memoryCtx({ options: { mode: "x" }, repo: "demo" });
		ctx.log.warn("careful");

		expect(ctx.warnings).toEqual(["careful"]);
		expect(ctx.options.mode).toBe("x");
		expect(ctx.repo.name).toBe("demo");
	});
});
