// Renders docs/errors.md from the core and cli code registries.
import { cliCodes } from "@tallyrelease/cli";
import { coreCodes } from "@tallyrelease/core";

import type { DocTarget } from "../runner.ts";
import type { CodeDoc } from "@tallyrelease/core";

const sections = (docs: [string, CodeDoc][]): string[] =>
	docs.flatMap(([code, { cause, fix }]) => [
		`### ${code}`,
		"",
		`Cause: ${cause}`,
		"",
		`Fix: ${fix}`,
		"",
	]);

export const errors: DocTarget = {
	name: "errors",
	path: "docs/errors.md",
	render: () => {
		const docs = Object.entries({ ...coreCodes.docs, ...cliCodes.docs }).sort(
			([a], [b]) => (a < b ? -1 : 1),
		);

		return [
			"# Error and warning codes",
			"",
			"Errors print as `error[E_CODE]: message` on stderr and make the command exit non-zero. Warnings print as `warning[W_CODE]: message` (prefixed with the plugin name when a plugin raised it) and do not stop the command. Pass `--verbose` to print debug output and, for unexpected errors, the stack and cause.",
			"",
			"Codes are only added, never removed or renamed. Plugins that define their own codes document them separately.",
			"",
			"## Errors",
			"",
			...sections(docs.filter(([code]) => code.startsWith("E_"))),
			"## Warnings",
			"",
			...sections(docs.filter(([code]) => code.startsWith("W_"))),
		].join("\n");
	},
};
