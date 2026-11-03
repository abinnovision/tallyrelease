// Writes the package version and git commit into dist/version.js.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

let commit = null;
try {
	commit = execFileSync("git", ["rev-parse", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
} catch {
	// No git or no repository, e.g. in a pruned payload.
}

writeFileSync(
	"dist/version.js",
	`export const version = ${JSON.stringify(version)};\nexport const commit = ${JSON.stringify(commit)};\n`,
);
