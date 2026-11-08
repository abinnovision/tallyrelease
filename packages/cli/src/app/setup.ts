import { matchBranch } from "@tallyrelease/core";

import { repoRef } from "./effects.js";
import { resolveBuildBase } from "../ci/base.js";
import { cliCodes } from "../codes.js";
import { branchName } from "../session.js";
import { version } from "../version.js";

import type { BuildBase } from "../ci/base.js";
import type { Session } from "../session.js";
import type {
	BuildChannel,
	PlanOptions,
	ReleasedUnit,
	Warning,
} from "@tallyrelease/core";

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

/** The HEAD sha; `E_NO_HEAD` in a repository without commits. */
export const resolveHead = async (session: Session): Promise<string> => {
	const head = await session.git.resolve("HEAD");
	if (head === undefined) {
		// Surfaces E_NOT_A_REPO and E_NOT_REPO_ROOT first.
		await session.workspace();
		throw cliCodes.error(
			"E_NO_HEAD",
			"HEAD does not resolve to a commit; the repository has no commits",
		);
	}

	return head;
};

/**
 * The build channel of `branch`: `nightly` when selected and the branch rule
 * sets a nightly channel, else `build`. `E_CHANNEL_SELECT` when `nightly` is
 * selected explicitly and the rule sets none.
 */
export const buildChannel = async (
	session: Session,
	branch: string,
): Promise<BuildChannel> => {
	const { channel, explicit } = session.channel();
	if (channel === "nightly") {
		const { branches } = (await session.workspace()).release;
		const line = matchBranch(branches, branch, { buildChannel: "nightly" });
		if (line?.channelKind === "nightly") {
			return "nightly";
		}

		if (explicit) {
			throw cliCodes.error(
				"E_CHANNEL_SELECT",
				`the nightly channel is selected, but ${line ? `branch rule "${line.rule}"` : `no branch rule of "${branch}"`} sets no channels.nightly`,
				{ branch, rule: line?.rule ?? null },
			);
		}
	}

	return "build";
};

/**
 * Plan options for `--branch`, `--base` and `--head`. With `--head` only
 * `--base` and the local merge base apply, and files come from the commit.
 * `channel: false` plans the build channel and skips the selection.
 */
export const planOptions = async (
	session: Session,
	flags: Pick<PlanFlags, "branch" | "base" | "head">,
	{ channel = true }: { channel?: boolean } = {},
): Promise<PlanSetup> => {
	const { git } = session;
	const current = await resolveHead(session);

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
	const branch = flags.branch ?? (await branchName(session));
	const selected = channel ? await buildChannel(session, branch) : "build";
	const base = await resolveBuildBase({
		git,
		head,
		env: replay ? {} : session.env,
		cliBase: flags.base,
		event: replay ? undefined : session.ci.event,
		baseInputs: replay ? undefined : session.ci.baseInputs,
		forge: replay ? undefined : session.forge,
		remote: session.remote,
		channel: selected,
	});

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
			buildChannel: selected,
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
 * commit and the release of the release tag; `forge` is null without a forge.
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
	const tags = [
		...new Set(
			released
				.filter((r) => !known.releases.has(r.tag))
				.map((r) => r.releaseTag),
		),
	];
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
	// Releases from before the group set `releaseTag` live on the member tag.
	const fallback = [
		...new Set(
			released
				.filter(
					(r) => r.releaseTag !== r.tag && releases.get(r.releaseTag) === null,
				)
				.map((r) => r.tag),
		),
	];
	const fallbackFound =
		repo && fallback.length > 0
			? await Promise.all(
					fallback.map(async (t) => await forge.releaseByTag(repo, t)),
				)
			: [];
	for (const [i, t] of fallback.entries()) {
		releases.set(t, fallbackFound[i]?.url ?? null);
	}

	return released.map((r) => {
		const url =
			known.releases.get(r.tag) ??
			releases.get(r.releaseTag) ??
			releases.get(r.tag) ??
			null;

		const pr = known.prs.get(r.tag) ?? prs.get(r.releaseSha) ?? null;

		return {
			...r,
			forge: { pr, release: url === null ? null : { url } },
		};
	});
};
