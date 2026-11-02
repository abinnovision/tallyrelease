// Validates every `tallyrelease.yaml` example in the markdown docs against the config schema.
import { Ajv } from "ajv";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { readSchema } from "./schema.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(
	readSchema("@tallyrelease/cli/tallyrelease.schema.json"),
);

const files = [
	"README.md",
	...readdirSync(`${root}docs`, { recursive: true, encoding: "utf8" })
		.filter((f) => f.endsWith(".md"))
		.map((f) => `docs/${f}`),
	...readdirSync(`${root}packages`)
		.map((p) => `packages/${p}/README.md`)
		.filter((f) => existsSync(`${root}${f}`)),
].sort();

const examples = files.flatMap((file) =>
	[
		...readFileSync(`${root}${file}`, "utf8").matchAll(
			/^```yaml\n(.*?)^```$/gms,
		),
	]
		.map((m) => m[1] ?? "")
		.map((block, index) => ({ file, index, block }))
		// Modeline-only blocks hold no config.
		.filter(
			({ block }) =>
				/^# (?:tallyrelease\.yaml|yaml-language-server:)/.test(block) &&
				/^[^#\s]/m.test(block),
		),
);

describe("config examples", () => {
	it("finds examples", () => {
		expect(examples.length).toBeGreaterThan(0);
	});

	it.each(examples)("$file block $index is valid", ({ block }) => {
		validate(parse(block));

		expect(ajv.errorsText(validate.errors)).toBe("No errors");
	});
});
