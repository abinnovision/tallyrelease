import { short } from "./short.js";

import type { ReleasedUnit } from "@tallyrelease/core";

/** release-please release name: `cli-v0.2.0` is `cli: v0.2.0`, `v1.0.0` stays. */
export const releaseName = ({ tag, version }: ReleasedUnit): string =>
	tag.endsWith(`-v${version}`)
		? `${tag.slice(0, -(version.length + 2))}: v${version}`
		: tag;

/** Reasons a merged release PR is labelled stale. */
export const staleReason = {
	noMarker: "its body has no valid tallyrelease marker",
	headMoved: (head: string, releaseCommit: string) =>
		`its head ${short(head)} is not the release commit ${short(releaseCommit)}`,
	planDiffers: (parent: string) =>
		`its releases differ from the plan at ${short(parent)}, the commit it was merged onto`,
	headOffLine: (head: string, parent: string) =>
		`its planned commit ${short(head)} is not on the first-parent chain of ${short(parent)}, the commit it was merged onto`,
	behindCut: (head: string) =>
		`its planned commit ${short(head)} predates the latest prerelease tag`,
	cutDiffers: (head: string, parent: string) =>
		head === parent
			? `the plan at ${short(head)}, its planned commit and the commit it was merged onto, no longer matches its marker`
			: `its prereleases differ from the plan at ${short(head)}, its planned commit, or their release changed by ${short(parent)}, the commit it was merged onto`,
	tagTaken: (tag: string, sha: string) =>
		`its tag ${tag} exists at ${short(sha)}`,
};

/** Comment on a release PR labelled stale. */
export const staleComment = (reason: string): string =>
	`tallyrelease did not tag this release PR: ${reason}. Its releases are proposed again in the next release PR.`;

/** Output lines of `release` per merged release PR; a dry run words them as intents. */
export const reconcileLines = (dryRun: boolean | undefined) => {
	const verb = (done: string, dry: string) => (dryRun ? dry : done);
	const pr = (number: number) => `PR #${String(number)}`;

	return {
		pending: (number: number, merge: string | null) =>
			`${pr(number)}: merge ${short(merge)} is not in HEAD; left pending`,
		stale: (number: number, reason: string) =>
			`${pr(number)}: ${verb("labelled", "would label")} stale: ${reason}`,
		tagged: (number: number, tags: readonly string[], sha: string) =>
			`${pr(number)}: ${verb("tagged", "would tag")} ${tags.join(", ")} at ${short(sha)}`,
		moved: (number: number, tags: readonly string[]) =>
			`${pr(number)}: ${verb("moved", "would move")} ${tags.join(", ")}`,
		created: (number: number, tags: readonly string[]) =>
			`${pr(number)}: ${verb("created", "would create")} releases ${tags.join(", ")}`,
		released: (number: number) =>
			`${pr(number)}: ${verb("labelled", "would label")} released`,
	};
};

/** Output of `release`. */
export const reconcileText = (lines: readonly string[]): string =>
	lines.length > 0 ? `${lines.join("\n")}\n` : "no merged release PRs\n";
