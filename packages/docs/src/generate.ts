// Regenerates docs/*.md. With --check, lists stale files and fails instead of writing.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { run } from "./runner.ts";
import { targets } from "./targets/index.ts";

const check = process.argv.includes("--check");
const stale = await run(targets, {
	root: fileURLToPath(new URL("../../..", import.meta.url)),
	check,
	read: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
	write: (file, content) => {
		writeFileSync(file, content);
	},
});

if (check && stale.length) {
	for (const path of stale) {
		process.stderr.write(`${path} is out of date.\n`);
	}

	process.stderr.write("Run `yarn fix`.\n");
	process.exitCode = 1;
}
