import type { ReleaseItem } from "@tallyrelease/core";

/** Body limit with headroom below GitHub's 65,536 characters. */
const BODY_LIMIT = 60_000;

const TRUNCATED =
	"_The changelog is truncated; the CHANGELOG.md files of this pull request hold all of it._";

/**
 * Per-unit changelog sections and per-item maintenance notes, cut to whole
 * blocks under the limit, then the marker.
 */
export const prBody = (
	{
		items,
		sections,
		notes,
	}: {
		items: readonly ReleaseItem[];
		sections: ReadonlyMap<string, string>;
		notes: ReadonlyMap<string, string>;
	},
	marker: string,
): string => {
	const blocks = items.flatMap((item) => [
		...item.units.flatMap((id) => {
			const section = sections.get(id);

			return section === undefined
				? []
				: [
						`<details><summary>${id}: ${item.version}</summary>\n\n${section}\n</details>\n\n`,
					];
		}),
		notes.get(item.name) ?? "",
	]);
	const budget = BODY_LIMIT - marker.length - TRUNCATED.length - 4;
	let text = "";
	for (const block of blocks) {
		if (text.length + block.length > budget) {
			text += `${TRUNCATED}\n\n`;
			break;
		}

		text += block;
	}

	return `${text}${marker}\n`;
};

/** Release PR title: the branch for the shared PR, else its items. */
export const prTitle = (
	leaf: string,
	branch: string,
	items: readonly ReleaseItem[],
): string =>
	leaf === "shared"
		? `chore(release): ${branch}`
		: `chore(release): ${items.map((i) => `${i.name}@${i.version}`).join(", ")}`;

/** Release PR note on cutting the maintenance branch of the line a new major leaves. */
export const maintenanceNote = (
	name: string,
	cut: { line: string; tag: string; branch: string },
	remote: string,
): string =>
	`**Maintenance line for ${name} ${cut.line}.** This PR releases a new major. To keep shipping fixes for ${cut.line}, cut the maintenance branch from the last ${cut.line} release (also possible later):\n\n\`\`\`\ngit push ${remote} ${cut.tag}:refs/heads/${cut.branch}\n\`\`\`\n\n`;

/** Comment on a release PR closed as not pending. */
export const closeComment = (base: string): string =>
	`tallyrelease closed this release PR: nothing in it is pending on \`${base}\` any more, or its releases moved to another release PR.`;

/** Output lines of `pr`; a dry run words them as intents. */
export const prLines = (dryRun: boolean | undefined) => {
	const pr = (number: number, branch: string) =>
		`PR #${String(number)} ${branch}`;

	return {
		created: (number: number, branch: string, title: string) =>
			`created ${pr(number, branch)}: ${title}`,
		wouldCreate: (branch: string, title: string) =>
			`would create PR ${branch}: ${title}`,
		upToDate: (number: number, branch: string) =>
			`${pr(number, branch)} is up to date`,
		updated: (number: number, branch: string, title: string) =>
			`${dryRun ? "would update" : "updated"} ${pr(number, branch)}: ${title}`,
		closed: (number: number, branch: string) =>
			`${dryRun ? "would close" : "closed"} ${pr(number, branch)}`,
		commitAs: ({ name, email }: { name: string; email: string }) =>
			`commit as ${name} <${email}>`,
		wouldPush: (branch: string, remote: string) =>
			`would push ${branch}${remote === "origin" ? "" : ` to ${remote}`}`,
	};
};

/** Output of `pr`. */
export const prText = (lines: readonly string[]): string =>
	lines.length > 0 ? `${lines.join("\n")}\n` : "no release PRs\n";
