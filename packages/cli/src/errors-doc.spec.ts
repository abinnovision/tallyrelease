import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");

const sourceCodes = () => {
	const files = globSync("packages/*/src/**/*.ts", {
		cwd: root,
		exclude: (f) => f.endsWith(".spec.ts"),
	});
	const codes = files.flatMap((f) =>
		[...read(f).matchAll(/\b[EW]_[A-Z][A-Z0-9_]*\b/g)].map((m) => m[0]),
	);

	return [...new Set(codes)].sort();
};

const documentedCodes = () =>
	[...read("docs/errors.md").matchAll(/^### ([EW]_[A-Z0-9_]+)$/gm)]
		.map((m) => m[1])
		.sort();

describe("docs/errors.md", () => {
	it("documents every error and warning code in the sources", () => {
		expect(documentedCodes()).toEqual(sourceCodes());
	});
});
