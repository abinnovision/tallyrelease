// Bundles an entry for the neutral platform. Node builtins are not resolvable
// there, so any direct or transitive builtin import fails the bundle.
import { build } from "esbuild";

const entry = process.argv[2];
if (!entry) {
	console.error("usage: check-purity.mjs <entry>");
	process.exit(2);
}

try {
	await build({
		entryPoints: [entry],
		bundle: true,
		write: false,
		platform: "neutral",
		mainFields: ["module", "main"],
		format: "esm",
		logLevel: "silent",
	});
} catch (error) {
	console.error(`purity check failed for ${entry}`);
	for (const e of error.errors ?? []) console.error(`  ${e.text}`);
	process.exit(1);
}
