import { describe, expect, it } from "vitest";

import { historyStep, renderHistory } from "./gitsvg.ts";

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

describe("historyStep", () => {
	it("keeps a prefix and hides lanes with their fork", () => {
		const full = {
			lanes: ["main", "fix"],
			commits: [
				{ lane: "main", subject: "a", branchFrom: "fix" },
				{ lane: "fix", subject: "b" },
				{ lane: "main", subject: "c" },
			],
		};

		expect(historyStep(full, { name: "s", commits: 2 }).commits).toHaveLength(
			2,
		);
		expect(
			historyStep(full, { name: "s", commits: 3, lanes: ["main"] }),
		).toEqual({
			lanes: ["main"],
			commits: [
				{ lane: "main", subject: "a" },
				{ lane: "main", subject: "c" },
			],
		});
	});
});

describe("markers and merges", () => {
	it("renders markers and a merge edge", () => {
		const svg = renderHistory(
			{
				lanes: ["main", "fix"],
				commits: [
					{ lane: "fix", subject: "a" },
					{ lane: "main", subject: "m", mergeFrom: "fix", markers: ["HEAD"] },
				],
			},
			"light",
		);

		expect(svg).toContain(">HEAD</text>");
		expect(svg).toContain("merges fix");
		expect(svg).toContain("marked HEAD");
		expect(svg).toMatch(/<path d="M\d+ \d+C/);
	});
});
