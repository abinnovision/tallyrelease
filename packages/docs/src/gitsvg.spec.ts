import { describe, expect, it } from "vitest";

import { renderHistory } from "./gitsvg.ts";

const history = {
	lanes: ["main"],
	commits: [{ lane: "main", subject: "chore: scaffold", tags: ["api-v1.0.0"] }],
};

describe("renderHistory", () => {
	it("renders both themes", () => {
		const light = renderHistory(history, "light");
		const dark = renderHistory(history, "dark");

		expect(light.startsWith("<svg")).toBe(true);
		expect(light).toContain(">api-v1.0.0</text>");
		expect(dark).toContain("#2dd4bf");
		expect(light).not.toContain("#2dd4bf");
	});
});
