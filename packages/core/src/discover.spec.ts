import { describe, expect, it } from "vitest";

import { memoryFs } from "./testing/index.js";
import { loadWorkspace } from "./workspace.js";

describe("discoverUnits", () => {
	it("sets buildNumber only when configured", async () => {
		const { units } = await loadWorkspace({
			config: {
				plugins: {},
				units: { a: {}, b: { buildNumber: { offset: 5 } } },
			},
			plugins: [],
			fs: memoryFs({ "a/x.ts": "", "b/x.ts": "" }),
			repo: { name: "demo" },
		});

		expect(units.map((u) => "buildNumber" in u)).toEqual([false, true]);
		expect(units[1]?.buildNumber).toEqual({ offset: 5 });
	});
});
