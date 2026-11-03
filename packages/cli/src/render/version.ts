/** Output of `version`: the updated paths; a dry run words them as intents. */
export const versionText = (
	paths: readonly string[],
	dryRun: boolean | undefined,
): string =>
	paths.length > 0
		? paths
				.map((path) => `${dryRun ? "would update" : "updated"} ${path}\n`)
				.join("")
		: "no version files to update\n";
