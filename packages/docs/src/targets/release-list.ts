// Renders docs/release-list.md from the release entry JSON schema of the cli.
import { cell, code } from "../markdown.ts";
import { readSchema, rows, typeOf } from "../schema.ts";

import type { DocTarget } from "../runner.ts";

export const releaseList: DocTarget = {
	name: "release-list",
	path: "docs/release-list.md",
	render: () => {
		const schema = readSchema("@tallyrelease/cli/releases.schema.json");
		// Described fields only.
		const fields = rows(schema, "").filter((r) => r.node.description);

		return [
			"# Release list",
			"",
			"`tallyrelease run --github-output` writes `releases` to `$GITHUB_OUTPUT`: a compact JSON array of everything to publish. The JSON schema is exported as `@tallyrelease/cli/releases.schema.json`.",
			"",
			"- Releases and cut prereleases come first, oldest release commit first, then in plan unit order.",
			"- Build prereleases follow in plan unit order. A unit released or cut at HEAD has no build prerelease entry.",
			"- Every stable tag in the range is listed, also several of one unit, so nothing tagged stays unpublished. A failed run lists its releases again on the next run.",
			"- Within a major, entries only gain fields.",
			"",
			"| Field | Type | Description |",
			"| --- | --- | --- |",
			...fields.map(
				(r) =>
					`| ${code(r.path.slice(1))} | ${cell(typeOf(r.node))} | ${cell(r.node.description ?? "")} |`,
			),
			"",
		].join("\n");
	},
};
