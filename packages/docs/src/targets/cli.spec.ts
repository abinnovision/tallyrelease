import { describe, expect, it } from "vitest";

import { cli } from "./cli.ts";

describe("cli", () => {
	const markdown = cli.render() as string;

	it("renders a section per command", () => {
		expect(markdown).toContain("## tallyrelease plan");
		expect(markdown).toContain("## tallyrelease explain");
	});

	it("renders choices and defaults", () => {
		expect(markdown).toContain("(one of `text`, `json` or `mermaid`)");
		expect(markdown).toContain(
			"| `--config <file>` | config file | `tallyrelease.yaml` |",
		);
	});
});
