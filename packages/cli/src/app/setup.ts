import { repoRef } from "./effects.js";
import { resolveBuildBase } from "../ci/base.js";
import { cliCodes } from "../codes.js";
import { branchName } from "../session.js";
import { version } from "../version.js";

import type { BuildBase } from "../ci/base.js";
import type { Session } from "../session.js";
import type { PlanOptions, ReleasedUnit, Warning } from "@tallyrelease/core";

export interface PlanFlags {
	branch?: string;
	base?: string;
	head?: string;
	all?: boolean;
	format?: "text" | "json";
	json?: boolean;
	out?: string;
	githubOutput?: boolean;
	summary?: boolean;
}

export interface PlanSetup {
	opts: Omit<PlanOptions, "fs">;
	/** `--head` sha, null to plan the working tree at HEAD. */
	ref: string | null;
	base: BuildBase;
	/** Base warnings and `W_HEAD_BRANCH`. */
	warnings: Warning[];
}

/**
 * Plan options for `--branch`, `--base` and `--head`. With `--head` only
 * `--base` and the local merge base apply, and files come from the commit.
 */
export const planOptions = async (
	session: Session,
	flags: Pick<PlanFlags, "branch" | "base" | "head">,
): Promise<PlanSetup> => {
	const { git } = session;
	const current = await git.resolve("HEAD");
	if (current === undefined) {
		// Surfaces E_NOT_A_REPO and E_NOT_REPO_ROOT first.
		await session.workspace();
		throw cliCodes.error(
			"E_NO_HEAD",
			"HEAD does not resolve to a commit; the repository has no commits",
		);
	}

	const head =
		flags.head === undefined ? current : await git.resolve(flags.head);
	if (head === undefined) {
		throw cliCodes.error(
			"E_HEAD_UNRESOLVED",
			`--head "${flags.head ?? ""}" does not resolve to a commit`,
			{ ref: flags.head },
		);
	}

	const replay = flags.head !== undefined;
	const base = await resolveBuildBase({
		git,
		head,
		env: replay ? {} : session.env,
		cliBase: flags.base,
		github: replay ? undefined : session.github,
		forge: replay ? undefined : session.forge,
		remote: session.remote,
	});

	const branch = flags.branch ?? (await branchName(session));
	const headBranch: Warning[] =
		replay && flags.branch === undefined
			? [
					cliCodes.warning(
						"W_HEAD_BRANCH",
						`planning --head under the branch rule for "${branch}"; pass --branch to choose`,
					),
				]
			: [];

	return {
		opts: {
			tool: `tallyrelease@${version}`,
			branch,
			head,
			base: base.base,
			baseSource: base.source,
		},
		ref: replay ? head : null,
		base,
		warnings: [...base.warnings, ...headBranch],
	};
};

/** Forge facts known from a reconcile, by tag. */
export interface KnownForge {
	prs: ReadonlyMap<string, { number: number; url: string }>;
	releases: ReadonlyMap<string, string | null>;
}

/**
 * `released` with `forge` from `known`, else the PR that merged the release
 * commit and the release of the tag; `forge` is null without a forge.
 */
export const releasedForge = async (
	session: Session,
	released: readonly ReleasedUnit[],
	known: KnownForge = { prs: new Map(), releases: new Map() },
): Promise<ReleasedUnit[]> => {
	const { forge } = session;
	if (!forge) {
		return released.map((r) => ({ ...r, forge: null }));
	}

	const shas = [
		...new Set(
			released.filter((r) => !known.prs.has(r.tag)).map((r) => r.releaseSha),
		),
	];
	const tags = released.map((r) => r.tag).filter((t) => !known.releases.has(t));
	const repo =
		shas.length > 0 || tags.length > 0 ? await repoRef(session) : undefined;
	const [foundPrs, foundReleases] = repo
		? await Promise.all([
				Promise.all(
					shas.map(async (sha) => await forge.prForCommit(repo, sha)),
				),
				Promise.all(tags.map(async (t) => await forge.releaseByTag(repo, t))),
			])
		: [[], []];
	const prs = new Map(
		shas.map((sha, i) => {
			const pr = foundPrs[i];

			return [sha, pr ? { number: pr.number, url: pr.url } : null];
		}),
	);
	const releases = new Map(
		tags.map((t, i) => [t, foundReleases[i]?.url ?? null]),
	);

	return released.map((r) => {
		const url = known.releases.get(r.tag) ?? releases.get(r.tag) ?? null;

		const pr = known.prs.get(r.tag) ?? prs.get(r.releaseSha) ?? null;

		return {
			...r,
			forge: { pr, release: url === null ? null : { url } },
		};
	});
};
