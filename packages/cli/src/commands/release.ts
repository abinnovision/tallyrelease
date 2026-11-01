import {
	computePlan,
	decodeMarker,
	planEquals,
	releasedFromTags,
	releaseNotes,
} from "@tallyrelease/core";

import { effectSkipped, repoRef } from "../app/effects.js";
import { planOptions } from "../app/setup.js";
import { cliCodes } from "../codes.js";
import { ForgeConflictError } from "../forge/errors.js";
import { LABELS } from "../forge/forge.js";
import {
	reconcileLines,
	reconcileText,
	releaseName,
	staleComment,
	staleReason,
} from "../render/release.js";

import type { PlanSetup } from "../app/setup.js";
import type { Forge, ReleasePr, RepoRef } from "../forge/forge.js";
import type { RepoGit } from "../git/reader.js";
import type { Session } from "../session.js";
import type {
	MarkerRelease,
	Plan,
	ReleasedUnit,
	TagRef,
	Workspace,
} from "@tallyrelease/core";

/**
 * GitHub release per entry unless one exists (a 422 on create means it does);
 * latest for entries marked `latest`. Returns the tags of the missing
 * releases, created unless `dryRun`, and the release URL of every entry,
 * null for one not created in a dry run.
 */
const createReleases = async (
	session: Session,
	{
		forge,
		repo,
		mergeSha,
		workspace,
		dryRun,
	}: {
		forge: Forge;
		repo: RepoRef;
		mergeSha: string;
		workspace: Workspace;
		dryRun: boolean | undefined;
	},
	{ released }: { released: readonly ReleasedUnit[] },
): Promise<{ created: string[]; urls: Map<string, string | null> }> => {
	const created: string[] = [];
	const urls = new Map<string, string | null>();
	/* eslint-disable no-await-in-loop -- sequential, avoids secondary rate limits */
	for (const r of released) {
		const existing = await forge.releaseByTag(repo, r.tag);
		if (existing !== undefined) {
			urls.set(r.tag, existing.url);
			continue;
		}

		created.push(r.tag);
		if (dryRun) {
			urls.set(r.tag, null);
			continue;
		}

		try {
			const release = await forge.createRelease(repo, {
				tag: r.tag,
				name: releaseName(r),
				body:
					releaseNotes(workspace, r.id, (path) =>
						session.readAt(mergeSha, path),
					) ?? "",
				makeLatest: r.latest,
			});
			urls.set(r.tag, release.url);
		} catch (error) {
			if (!(error instanceof ForgeConflictError)) {
				throw error;
			}

			urls.set(r.tag, (await forge.releaseByTag(repo, r.tag))?.url ?? null);
		}
	}
	/* eslint-enable no-await-in-loop */

	return { created, urls };
};

/**
 * Workspace and plan at the first parent of `mergeSha`; `plan` is undefined
 * when `releases` are given and do not equal it.
 */
export const planAtParent = async (
	session: Session,
	{
		git,
		opts,
		mergeSha,
		releases,
	}: {
		git: RepoGit;
		opts: PlanSetup["opts"];
		mergeSha: string;
		releases: readonly MarkerRelease[] | undefined;
	},
): Promise<{
	parent: string;
	plan: { workspace: Workspace; plan: Plan } | undefined;
}> => {
	const parent = await git.resolve(`${mergeSha}^1`);
	if (parent === undefined) {
		return { parent: mergeSha, plan: undefined };
	}

	return {
		parent,
		plan: await session.workspaceAt(parent, async (workspace, fs) => {
			const plan = await computePlan(workspace, git, {
				...opts,
				head: parent,
				base: parent,
				fs,
				all: true,
			});

			return releases === undefined || planEquals(releases, plan, workspace)
				? { workspace, plan }
				: undefined;
		}),
	};
};

/** `git` with `local` tags on top; dry runs tag here instead of the repository. */
export const withTags = (
	git: RepoGit,
	local: ReadonlyMap<string, string>,
): RepoGit => {
	const merge = (tags: readonly TagRef[], extra: TagRef[]) =>
		[...tags.filter((t) => !local.has(t.name)), ...extra].sort((a, b) =>
			a.name < b.name ? -1 : 1,
		);
	const refs = () => [...local].map(([name, sha]) => ({ name, sha }));

	return {
		...git,
		tags: async () => merge(await git.tags(), refs()),
		tagsMerged: async (ref) => {
			const head = (await git.resolve(ref)) ?? ref;
			const merged = await Promise.all(
				refs().map(async (t) =>
					(await git.isAncestor(t.sha, head)) ? [t] : [],
				),
			);

			return merge(await git.tagsMerged(ref), merged.flat());
		},
		resolve: async (ref) => local.get(ref) ?? (await git.resolve(ref)),
	};
};

export interface ReleaseFlags {
	branch?: string;
	dryRun?: boolean;
}

/** A merged release PR tagged by `reconcile`, with its version tags. */
export interface Reconciled {
	number: number;
	/** Web URL of the PR. */
	url: string;
	tags: string[];
	/** Forge release URL by tag of the released units; null when not created in a dry run. */
	releases: Map<string, string | null>;
	/** Merge commit the tags point at. */
	sha: string;
	/** Plan units at the first parent of `sha`. */
	units: Plan["units"];
}

/**
 * Tags merged release PRs labelled `tallyrelease: pending` on the branch,
 * oldest merge first: a PR whose marker matches its head and the plan at the
 * first parent of its merge gets its version and floating tags at the merge
 * (one atomic push), a GitHub release per unit and the `released` label; any
 * other PR is labelled `stale` with a comment. Merges that are not in HEAD
 * stay pending. Returns the tagged PRs, including those whose tags existed,
 * or undefined when `command` (`release` or `run`) is skipped. `ready` runs
 * after the skip checks and before any effect.
 */
export const reconcile = async (
	session: Session,
	flags: ReleaseFlags,
	{ command, ready }: { command: string; ready: () => Promise<void> },
): Promise<Reconciled[] | undefined> => {
	if (effectSkipped(session, command)) {
		return undefined;
	}

	// Reconcile needs no build base; HEAD as base skips the forge lookup.
	const setup = await planOptions(session, {
		...(flags.branch !== undefined && { branch: flags.branch }),
		base: "HEAD",
	});
	const { opts } = setup;
	const atHead = await session.planAt(null, opts);
	if (effectSkipped(session, command, atHead)) {
		return undefined;
	}

	await ready();

	const { forge, gitWriter } = session;
	const dryTags = new Map<string, string>();
	const git = flags.dryRun ? withTags(session.git, dryTags) : session.git;
	const tag = async (name: string, sha: string, force = false) => {
		if (!flags.dryRun) {
			await gitWriter.tag(name, sha, { force });

			return;
		}

		const current = await git.resolve(name);
		if (current !== undefined && current !== sha && !force) {
			throw cliCodes.error(
				"E_TAG_EXISTS",
				`tag "${name}" exists at ${current}, not at ${sha}`,
				{ tag: name, sha: current, expected: sha },
			);
		}

		dryTags.set(name, sha);
	};

	if (!forge) {
		throw cliCodes.error(
			"E_NO_FORGE",
			"release needs a forge token; pass --token or set GITHUB_TOKEN",
		);
	}

	const repo = await repoRef(session);
	const merged = await forge.releasePrs(repo, {
		base: atHead.branch,
		state: "merged",
	});
	const lines: string[] = [];
	const reconciled: Reconciled[] = [];
	const line = reconcileLines(flags.dryRun);

	const stale = async (pr: ReleasePr, reason: string) => {
		if (!flags.dryRun) {
			await forge.setLabel(repo, pr.number, {
				label: LABELS.stale,
				comment: staleComment(reason),
			});
		}

		lines.push(line.stale(pr.number, reason));
	};

	/* eslint-disable no-await-in-loop -- each PR is planned after the tags of the earlier ones */
	for (const pr of merged) {
		const mergeSha =
			pr.mergeCommitSha === null
				? undefined
				: await git.resolve(pr.mergeCommitSha);
		if (
			mergeSha === undefined ||
			!(await git.isAncestor(mergeSha, opts.head))
		) {
			lines.push(line.pending(pr.number, pr.mergeCommitSha));
			continue;
		}

		const marker = decodeMarker(pr.body);
		if (!marker) {
			await stale(pr, staleReason.noMarker);
			continue;
		}

		if (pr.headSha !== marker.releaseCommit) {
			await stale(pr, staleReason.headMoved(pr.headSha, marker.releaseCommit));
			continue;
		}

		const tags = marker.releases.map((r) => r.tag);
		const current = await Promise.all(
			tags.map(async (t) => await git.resolve(t)),
		);
		// Tags already at the merge: a run after a partial failure; no plan check.
		const tagged = current.every((sha) => sha === mergeSha);
		const planned = await planAtParent(session, {
			git,
			opts,
			mergeSha,
			releases: tagged ? undefined : marker.releases,
		});
		if (!planned.plan) {
			await stale(pr, staleReason.planDiffers(planned.parent));
			continue;
		}

		const { workspace, plan } = planned.plan;
		for (const t of tags) {
			await tag(t, mergeSha);
		}

		const released = await releasedFromTags(workspace, plan, {
			git,
			tags,
		});
		const floating = [...new Set(released.flatMap((r) => r.floatingTags))];
		const floatingCurrent = await Promise.all(
			floating.map(async (t) => await git.resolve(t)),
		);
		for (const t of floating) {
			await tag(t, mergeSha, true);
		}

		if (!tagged || floatingCurrent.some((sha) => sha !== mergeSha)) {
			lines.push(line.tagged(pr.number, tags, mergeSha));
			if (!flags.dryRun) {
				await gitWriter.push(
					[
						...tags.map((t) => `refs/tags/${t}`),
						...floating.map((t) => `+refs/tags/${t}`),
					],
					{ atomic: true, token: session.token },
				);
			}

			if (floating.length > 0) {
				lines.push(line.moved(pr.number, floating));
			}
		}

		const { created, urls } = await createReleases(
			session,
			{
				forge,
				repo,
				mergeSha,
				workspace,
				dryRun: flags.dryRun,
			},
			{ released },
		);
		if (created.length > 0) {
			lines.push(line.created(pr.number, created));
		}

		if (!flags.dryRun) {
			await forge.setLabel(repo, pr.number, { label: LABELS.released });
		}

		lines.push(line.released(pr.number));
		reconciled.push({
			number: pr.number,
			url: pr.url,
			tags,
			releases: urls,
			sha: mergeSha,
			units: plan.units,
		});
	}
	/* eslint-enable no-await-in-loop */

	session.warn(setup.warnings);
	session.stdout.write(reconcileText(lines));

	return reconciled;
};
