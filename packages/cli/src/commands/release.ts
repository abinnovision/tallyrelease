import {
	computePlan,
	cutEquals,
	cutReleaseNotes,
	decodeMarker,
	planEquals,
	previousCut,
	releasedFromTags,
	releaseItems,
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
	Marker,
	MarkerRelease,
	Plan,
	ReadonlyFs,
	ReleasedUnit,
	TagRef,
	Warning,
	Workspace,
} from "@tallyrelease/core";

/**
 * GitHub release per entry unless one exists (a 422 on create means it does);
 * latest for entries marked `latest`, a prerelease for cuts with the body from
 * `notes`. Returns the tags of the missing releases, created unless `dryRun`,
 * and the release URL of every entry, null for one not created in a dry run.
 */
const createReleases = async (
	session: Session,
	{
		forge,
		repo,
		mergeSha,
		workspace,
		dryRun,
		notes,
	}: {
		forge: Forge;
		repo: RepoRef;
		mergeSha: string;
		workspace: Workspace;
		dryRun: boolean | undefined;
		/** Cut release notes by unit id. */
		notes: ReadonlyMap<string, string> | undefined;
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
					(r.prerelease
						? notes?.get(r.id)
						: releaseNotes(workspace, r.id, (path) =>
								session.readAt(mergeSha, path),
							)) ?? "",
				makeLatest: r.latest,
				prerelease: r.prerelease,
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
 * Why a merged prerelease PR planned at `marker.head` cannot be tagged at
 * `mergeSha` on `atP` (the plan at the first parent of its merge), else
 * undefined.
 */
const cutProblem = async (
	session: Session,
	{
		git,
		opts,
		marker,
		mergeSha,
		atP,
	}: {
		git: RepoGit;
		opts: PlanSetup["opts"];
		marker: Marker;
		mergeSha: string;
		atP: PlannedCommit;
	},
): Promise<string | undefined> => {
	const { head } = marker;
	const parent = atP.plan.head;
	if (
		(await git.resolve(head)) === undefined ||
		!(await git.isFirstParentAncestor(head, parent))
	) {
		return staleReason.headOffLine(head, parent);
	}

	const ids = new Set(marker.releases.map((r) => r.id));
	if (!(await descendsFromCuts(atP, { git, head, ids }))) {
		return staleReason.behindCut(head);
	}

	const current = await Promise.all(
		marker.releases.map(
			async (r) => [r.tag, await git.resolve(r.tag)] as const,
		),
	);
	const taken = current.find(
		([, sha]) => sha !== undefined && sha !== mergeSha,
	);
	if (taken?.[1] !== undefined) {
		return staleReason.tagTaken(taken[0], taken[1]);
	}

	const atH =
		head === parent
			? atP
			: await planAtCommit(session, { git, opts, sha: head });

	return cutEquals(marker.releases, atH, atP)
		? undefined
		: staleReason.cutDiffers(head, parent);
};

/**
 * Release notes of the cuts in `releases` at `atP`, by unit id; undefined
 * when every cut has a forge release.
 */
const missingCutNotes = async (
	session: Session,
	{
		git,
		forge,
		repo,
		atP,
		releases,
	}: {
		git: RepoGit;
		forge: Forge;
		repo: RepoRef;
		atP: PlannedCommit;
		releases: readonly MarkerRelease[];
	},
): Promise<{ notes: Map<string, string>; warnings: Warning[] } | undefined> => {
	const found = await Promise.all(
		releases.map(async (r) => await forge.releaseByTag(repo, r.tag)),
	);
	if (found.every((r) => r !== undefined)) {
		return undefined;
	}

	const byId = new Map(releases.map((r) => [r.id, r]));
	const versions = new Map(releases.map((r) => [r.id, r.version]));
	const prUnits = [...byId.keys()];
	const repoUrl = await session.repoUrl();
	const date = session.clock().toISOString().slice(0, 10);
	const notes = new Map<string, string>();
	const warnings: Warning[] = [];
	/* eslint-disable no-await-in-loop -- hooks run in order */
	for (const item of releaseItems(atP.workspace, atP.plan)) {
		const version = item.units
			.map((id) => byId.get(id)?.version)
			.find((v) => v !== undefined);
		if (version === undefined) {
			continue;
		}

		const result = await cutReleaseNotes(atP.workspace, atP.plan, {
			fs: atP.fs,
			item: {
				...item,
				version,
				tags: item.units.flatMap((id) => {
					const r = byId.get(id);

					return r ? [{ id, tag: r.tag }] : [];
				}),
			},
			prUnits,
			versions,
			date,
			repoUrl,
			git,
		});
		for (const [id, note] of result.notes) {
			notes.set(id, note);
		}

		warnings.push(...result.warnings);
	}
	/* eslint-enable no-await-in-loop */

	return { notes, warnings };
};

/**
 * Plan at the first parent of the merge of `pr`, else why the PR cannot be
 * tagged there; a PR whose tags exist at the merge is not checked.
 */
const mergedPlan = async (
	session: Session,
	{
		git,
		opts,
		pr,
		marker,
		mergeSha,
		tagged,
	}: {
		git: RepoGit;
		opts: PlanSetup["opts"];
		pr: ReleasePr;
		marker: Marker;
		mergeSha: string;
		tagged: boolean;
	},
): Promise<PlannedCommit | string> => {
	const { parent, plan: atP } = await planAtParent(session, {
		git,
		opts,
		mergeSha,
	});
	if (!atP) {
		return staleReason.planDiffers(parent);
	}

	if (tagged) {
		return atP;
	}

	if (pr.head.startsWith(CUT_PREFIX)) {
		return (
			(await cutProblem(session, { git, opts, marker, mergeSha, atP })) ?? atP
		);
	}

	return planEquals(marker.releases, atP.plan, atP.workspace)
		? atP
		: staleReason.planDiffers(parent);
};

/** Workspace, files and plan of a commit. */
interface PlannedCommit {
	workspace: Workspace;
	plan: Plan;
	fs: ReadonlyFs;
}

/** Head branch prefix of the prerelease PRs of every base branch. */
export const CUT_PREFIX = "tallyrelease/prerelease/";

/** Workspace, files and plan (`all`) at `sha`, read through `git`. */
export const planAtCommit = async (
	session: Session,
	{ git, opts, sha }: { git: RepoGit; opts: PlanSetup["opts"]; sha: string },
): Promise<PlannedCommit> =>
	await session.workspaceAt(sha, async (workspace, fs) => ({
		workspace,
		fs,
		plan: await computePlan(workspace, git, {
			...opts,
			head: sha,
			base: sha,
			fs,
			all: true,
		}),
	}));

/** Workspace and plan at the first parent of `mergeSha`, undefined without one. */
export const planAtParent = async (
	session: Session,
	{
		git,
		opts,
		mergeSha,
	}: { git: RepoGit; opts: PlanSetup["opts"]; mergeSha: string },
): Promise<{ parent: string; plan: PlannedCommit | undefined }> => {
	const parent = await git.resolve(`${mergeSha}^1`);

	return parent === undefined
		? { parent: mergeSha, plan: undefined }
		: { parent, plan: await planAtCommit(session, { git, opts, sha: parent }) };
};

/**
 * True when `head` descends from the previous cut tag (on `at.plan.head`'s
 * chain) of each unit in `ids`.
 */
export const descendsFromCuts = async (
	at: Pick<PlannedCommit, "workspace" | "plan">,
	{ git, head, ids }: { git: RepoGit; head: string; ids: ReadonlySet<string> },
): Promise<boolean> => {
	const previous = await previousCut(at.workspace, at.plan, { git });
	const found = await Promise.all(
		[...previous].map(async ([id, tag]) =>
			tag === null || !ids.has(id) ? true : await git.isAncestor(tag.sha, head),
		),
	);

	return found.every(Boolean);
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
	const warnings: Warning[] = [];
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
		const atP = await mergedPlan(session, {
			git,
			opts,
			pr,
			marker,
			mergeSha,
			tagged,
		});
		if (typeof atP === "string") {
			await stale(pr, atP);
			continue;
		}

		const { workspace, plan } = atP;
		// Cut notes before any effect, only for missing releases.
		const cutNotes = pr.head.startsWith(CUT_PREFIX)
			? await missingCutNotes(session, {
					git,
					forge,
					repo,
					atP,
					releases: marker.releases,
				})
			: undefined;
		warnings.push(...(cutNotes?.warnings ?? []));
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
				notes: cutNotes?.notes,
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

	session.warn([...setup.warnings, ...warnings]);
	session.stdout.write(reconcileText(lines));

	return reconciled;
};
