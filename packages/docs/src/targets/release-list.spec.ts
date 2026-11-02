import { describe, expect, it } from "vitest";

import { releaseList } from "./release-list.ts";

describe("releaseList", () => {
	it("renders top-level and nested fields", () => {
		const markdown = releaseList.render() as string;

		expect(markdown).toContain("| `catchUp` | boolean |");
		expect(markdown).toContain("| `forge.pr` | object or null |");
	});
});
