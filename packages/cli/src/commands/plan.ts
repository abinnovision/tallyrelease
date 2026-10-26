import { TallyError } from "@tallyrelease/core";
import { join, resolve } from "node:path";

import { repoRef } from "./effects.js";
import { baseLabel, baseLine, resolveBuildBase } from "../ci/base.js";
import { planGithubOutput, releasesGithubOutput } from "../ci/outputs.js";
import { appendStepSummary } from "../ci/summary.js";
import { cliCodes } from "../codes.js";
import { alignColumns } from "../output/columns.js";
import { count } from "../output/count.js";
import { painter } from "../output/paint.js";
import { branchName } from "../session.js";
import { version } from "../version.js";

import type { BuildBase } from "../ci/base.js";
import type { ReleaseEntry } from "../plan-schema.js";
import type { Session } from "../session.js";
import type {
	Plan,
	PlanLine,
	PlanOptions,
	ReleasedUnit,
	Warning,
} from "@tallyrelease/core";

const lineLabel = (line: PlanLine | null, branch: string): string =>
	line === null
		? `${branch} (no branch rule)`
		: `${branch} (rule ${line.rule}, ${line.kind} line${line.channel === null ? "" : `, channel ${line.channel}`}${line.maxBump === null ? "" : `, max bump ${line.maxBump}`}${line.absolute === null ? "" : `, base ${String(line.absolute.major)}.${line.absolute.minor === undefined ? "x" : String(line.absolute.minor)} of ${line.absolute.unit ?? line.absolute.group ?? ""}`})`;

const text = (session: Session, doc: Plan, base: BuildBase): string => {
	const paint = painter(session.stdout);
	const lines = [
		`${paint("bold", "branch")}  ${lineLabel(doc.line, doc.branch)}`,
		baseLine(paint, base),
		"",
	];
	if (doc.units.length === 0) {
		lines.push("no units planned");

		return `${lines.join("\n")}\n`;
	}

	const grouped = doc.units.some((u) => u.group !== null);
	const table = [
		[
			"UNIT",
			...(grouped ? ["GROUP"] : []),
			"KIND",
			"FROM",
			"BUMP",
			"NEXT",
			"VERSION",
		],
		...doc.units.map((u) => [
			u.id,
			...(grouped ? [u.group ?? "-"] : []),
			u.kind,
			u.from ?? "-",
			u.bump ?? "-",
			u.next ?? "-",
			u.version ?? "-",
		]),
	];
	// Header is aligned unstyled so column styles do not apply to it.
	const [header = ""] = alignColumns(table);
	const [, ...rows] = alignColumns(
		table,
		{ styles: grouped ? [undefined, "dim", "cyan"] : [undefined, "cyan"] },
		paint,
	);
	const kinds = (["prerelease", "rebuild", "none"] as const)
		.map((kind) => [kind, doc.units.filter((u) => u.kind === kind).length])
		.filter(([, n]) => n !== 0)
		.map(([kind, n]) => `${String(n)} ${String(kind)}`);
	lines.push(
		paint("bold", header),
		...rows,
		"",
		`${count(doc.units.length, "unit")} planned: ${kinds.join(", ")}`,
	);

	return `${lines.join("\n")}\n`;
};

const markdown = (doc: Plan, base: BuildBase): string => {
	const lines = [
		"### tallyrelease plan",
		"",
		`Branch ${lineLabel(doc.line, doc.branch)}.`,
		"",
		`Base ${base.base?.slice(0, 7) ?? "none"} (${baseLabel(base)}).`,
		"",
	];
	if (doc.units.length === 0) {
		lines.push("No units planned.");
	} else {
		const grouped = doc.units.some((u) => u.group !== null);
		lines.push(
			`| Unit |${grouped ? " Group |" : ""} Kind | From | Bump | Next | Version |`,
			`| :-- |${grouped ? " :-- |" : ""} :-- | :-- | :-- | :-- | :-- |`,
			...doc.units.map(
				(u) =>
					`| ${u.id} |${grouped ? ` ${u.group ?? "-"} |` : ""} ${u.kind} | ${u.from ?? "-"} | ${u.bump ?? "-"} | ${u.next ?? "-"} | ${u.version ?? "-"} |`,
			),
		);
	}

	if (doc.warnings.length > 0) {
		lines.push(
			"",
			"Warnings:",
			"",
			...doc.warnings.map((w) => `- ${w.code}: ${w.message}`),
		);
	}

	return `${lines.join("\n")}\n`;
};

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

/** Writes `doc` to `--out`, `$GITHUB_OUTPUT`, the step summary and stdout. */
export const writePlan = (
	session: Session,
	{
		doc,
		base,
		releases,
	}: { doc: Plan; base: BuildBase; releases?: readonly ReleaseEntry[] },
	flags: Pick<
		PlanFlags,
		"format" | "json" | "out" | "githubOutput" | "summary"
	>,
): void => {
	const json = `${JSON.stringify(doc, null, 2)}\n`;
	const out =
		flags.out === undefined ? undefined : resolve(session.cwd, flags.out);
	if (out !== undefined) {
		session.writeOutFile(out, json);
	}

	if (flags.githubOutput) {
		const outputPath = session.env["GITHUB_OUTPUT"];
		if (!outputPath) {
			throw cliCodes.error(
				"E_GITHUB_OUTPUT",
				"--github-output requires GITHUB_OUTPUT to be set",
			);
		}

		const temp = session.env["RUNNER_TEMP"];
		if (out === undefined && !temp) {
			throw cliCodes.error(
				"E_GITHUB_OUTPUT",
				"--github-output requires --out or RUNNER_TEMP to be set",
			);
		}

		const path = out ?? join(temp ?? "", "tallyrelease-plan.json");
		if (out === undefined) {
			session.writeOutFile(path, json);
		}

		session.appendFile(
			outputPath,
			planGithubOutput(path) +
				(releases === undefined ? "" : releasesGithubOutput(releases)),
		);
	}

	const appended =
		flags.summary && appendStepSummary(session, markdown(doc, base));

	const format = flags.format ?? (flags.json ? "json" : "text");
	session.stdout.write(
		format === "json"
			? json
			: flags.summary && !appended
				? markdown(doc, base)
				: text(session, doc, base),
	);
};

/** Computes the release plan and writes the requested outputs. */
export const plan = async (
	session: Session,
	flags: PlanFlags,
): Promise<void> => {
	const { opts, ref, base, warnings } = await planOptions(session, flags);
	const planned = await session.planAt(
		ref,
		{ ...opts, all: flags.all ?? false },
		{ released: true },
	);
	// A forge request failure leaves `forge` null; plan stays lenient.
	let { released } = planned;
	const prWarnings: Warning[] = [];
	try {
		released = await releasedForge(session, released);
	} catch (error) {
		if (error instanceof TallyError) {
			throw error;
		}

		prWarnings.push(
			cliCodes.warning(
				"W_FORGE_ERROR",
				`cannot read the PRs and releases of released commits: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
	}

	const doc = {
		...planned,
		released,
		warnings: [...planned.warnings, ...warnings, ...prWarnings],
	};
	session.warn(doc.warnings);
	writePlan(session, { doc, base }, flags);
};
