/**
 * Output of `version`: the updated, then the deleted paths; a dry run words
 * them as intents.
 */
export const versionText = (
	paths: readonly string[],
	deletes: readonly string[],
	dryRun: boolean | undefined,
): string =>
	paths.length + deletes.length > 0
		? [
				...paths.map(
					(path) => `${dryRun ? "would update" : "updated"} ${path}\n`,
				),
				...deletes.map(
					(path) => `${dryRun ? "would delete" : "deleted"} ${path}\n`,
				),
			].join("")
		: "no version files to update\n";
