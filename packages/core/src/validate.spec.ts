import { describe, expect, it } from "vitest";

import { memoryFs } from "./testing/index.js";
import { validateRelease } from "./validate.js";
import { loadWorkspace } from "./workspace.js";

const workspace = async (scheme: string, release: boolean) =>
	await loadWorkspace({
		config: { plugins: {}, units: { a: { scheme, release } } },
		plugins: [],
		fs: memoryFs({ "a/x.ts": "" }),
		repo: { name: "demo" },
	});

describe("validateRelease", () => {
	it("rejects an unknown scheme of a released unit only", async () => {
		const unreleased = await workspace("nope", false);
		const released = await workspace("nope", true);
		expect(() => {
			validateRelease(unreleased);
		}).not.toThrow();
		expect(() => {
			validateRelease(released);
		}).toThrow(expect.objectContaining({ code: "E_SCHEME_UNKNOWN" }));
	});
});
