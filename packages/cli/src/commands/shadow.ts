import { computePlan, TallyError } from "@tallyrelease/core";
import { resolve } from "node:path";

import { appendStepSummary } from "../ci/summary.js";
import { cliCodes } from "../codes.js";
import { count } from "../output/count.js";
import {
	shadowAnnotation,
	shadowMarkdown,
	shadowText,
} from "../render/shadow.js";
import { short } from "../render/short.js";
import { branchName } from "../session.js";
import { compareShadow, unlabelled } from "../shadow/compare.js";
import { version } from "../version.js";

import type { RepoGit } from "../git/reader.js";
import type { Session } from "../session.js";
import type { ShadowReport } from "../shadow/compare.js";
import type {
	CodeOf,
	coreCodes,
	ErrorCode,
	Plan,
	Warning,
} from "@tallyrelease/core";

const CAP_ERRORS: ReadonlySet<string> = new Set<
	ErrorCode<CodeOf<typeof coreCodes>>
>(["E_CAP", "E_CAP_BASE"]);

const MANIFEST = ".release-please-manifest.json";
const RP_CONFIG = "release-please-config.json";

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Parsed JSON object; `{}` when the file is absent. */
const readJson = (
	content: string | undefined,
	path: string,
	strings = false,
): Record<string, unknown> => {
	if (content === undefined) {
		return {};
	}

	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch (error) {
		throw cliCodes.error(
			"E_SHADOW_INPUT",
			`cannot parse "${path}": ${error instanceof Error ? error.message : String(error)}`,
			{ path },
		);
	}

	if (
		!isObject(value) ||
		(strings && Object.values(value).some((v) => typeof v !== "string"))
	) {
		throw cliCodes.error(
			"E_SHADOW_INPUT",
			`"${path}" must be a JSON object${strings ? " of version strings" : ""}`,
			{ path },
		);
	}

	return value;
};

const readManifest = (content: string | undefined, path: string) =>
	readJson(content, path, true) as Record<string, string>;

/** Full messages of the commits since each changed unit's base tag. */
const commitMessages = async (
	git: RepoGit,
	plan: Plan,
	paths: ReadonlySet<string>,
): Promise<Map<string, string>> => {
	const messages = new Map<string, string>();
	const tags = new Set(
		plan.units.filter((u) => paths.has(u.path)).map((u) => u.baseTag),
	);
	for (const tag of tags) {
		// eslint-disable-next-line no-await-in-loop -- one log per base tag
		const from = tag === null ? null : ((await git.resolve(tag)) ?? null);
		// eslint-disable-next-line no-await-in-loop -- one log per base tag
		for (const c of await git.log(from, plan.head)) {
			messages.set(c.sha, c.message);
		}
	}

	return messages;
};

/** Plans `report.planned` and fills the rows; a cap error becomes a skip. */
const compareAt = async (
	session: Session,
	report: ShadowReport,
	{ planned, rpConfig }: { planned: string; rpConfig: string },
): Promise<void> => {
	const { git } = session;
	const { manifest, head } = report;
	try {
		const { plan, units, before, bumpTypes } = await session.workspaceAt(
			planned,
			async (workspace, files) => ({
				plan: await computePlan(workspace, git, {
					tool: report.tool,
					branch: report.branch,
					head: planned,
					base: null,
					baseSource: "none",
					all: true,
					fs: files,
				}),
				units: workspace.units.map((u) => ({
					id: u.id,
					path: u.root,
					released: u.version !== "none",
					dependsOn: workspace.graph.dependencies.get(u.id) ?? [],
				})),
				before: readManifest(files.read(manifest), manifest),
				bumpTypes: new Set(workspace.release.bumps.keys()),
			}),
		);
		const after = readManifest(session.readAt(head, manifest), manifest);
		const changed = new Set(
			Object.keys(after).filter((p) => before[p] !== after[p]),
		);
		report.rows = compareShadow({
			before,
			after,
			plan,
			units,
			rpConfig: readJson(session.readAt(head, rpConfig), rpConfig),
			messages: await commitMessages(git, plan, changed),
			bumpTypes,
		});
		report.warnings.push(...plan.warnings);
	} catch (error) {
		if (!(error instanceof TallyError) || !CAP_ERRORS.has(error.code)) {
			throw error;
		}

		report.skipped = { reason: "cap", message: error.message };
	}
};

/** Writes `--out`, the step summary, stdout and annotations. */
const writeReport = (
	session: Session,
	flags: ShadowFlags,
	report: ShadowReport,
): void => {
	const { env } = session;
	if (flags.out !== undefined) {
		session.writeOutFile(
			resolve(session.cwd, flags.out),
			`${JSON.stringify(report, null, 2)}\n`,
		);
	}

	const appended =
		flags.summary && appendStepSummary(session, shadowMarkdown(report));
	session.stdout.write(
		flags.summary && !appended ? shadowMarkdown(report) : shadowText(report),
	);

	if (env["GITHUB_ACTIONS"] === "true") {
		for (const r of unlabelled(report.rows)) {
			session.stdout.write(shadowAnnotation(r));
		}
	}
};

/** `W_SHADOW_INPUT_MISSING` for an explicit `--manifest` or `--rp-config` absent at `head`. */
const missingInputs = (
	session: Session,
	flags: ShadowFlags,
	head: string,
): Warning[] =>
	[flags.manifest, flags.rpConfig]
		.filter((path) => path !== undefined)
		.filter((path) => session.readAt(head, path) === undefined)
		.map((path) =>
			cliCodes.warning(
				"W_SHADOW_INPUT_MISSING",
				`"${path}" does not exist at ${short(head)}`,
			),
		);

export type { ShadowReport } from "../shadow/compare.js";

export interface ShadowFlags {
	manifest?: string;
	rpConfig?: string;
	head?: string;
	branch?: string;
	pin?: string;
	out?: string;
	summary?: boolean;
	strict?: boolean;
}

/** Compares the plan before a release-please merge with its manifest change. */
export const shadow = async (
	session: Session,
	flags: ShadowFlags,
): Promise<void> => {
	const { git } = session;
	const manifest = flags.manifest ?? MANIFEST;
	const head = await git.resolve(flags.head ?? "HEAD");
	if (head === undefined) {
		if (flags.head === undefined) {
			// Surfaces E_NOT_A_REPO and E_NOT_REPO_ROOT first.
			await session.workspace();
		}

		throw cliCodes.error(
			"E_HEAD_UNRESOLVED",
			`"${flags.head ?? "HEAD"}" does not resolve to a commit`,
			{ ref: flags.head },
		);
	}

	const planned = (await git.resolve(`${head}^1`)) ?? null;
	const sha = session.env["GITHUB_SHA"] ?? null;
	const report: ShadowReport = {
		schema: 1,
		tool: `tallyrelease@${version}`,
		pin: flags.pin ?? null,
		sha,
		replay: flags.head !== undefined || (sha !== null && sha !== head),
		branch: flags.branch ?? (await branchName(session)),
		head,
		planned,
		manifest,
		skipped: null,
		rows: [],
		warnings: missingInputs(session, flags, head),
	};

	if (
		planned !== null &&
		(await git.diffFiles(planned, head)).includes(manifest)
	) {
		await compareAt(session, report, {
			planned,
			rpConfig: flags.rpConfig ?? RP_CONFIG,
		});
	} else {
		report.skipped = {
			reason: "manifest",
			message: `${manifest} did not change in ${short(head)}`,
		};
	}

	if (report.skipped) {
		report.warnings.push(
			cliCodes.warning(
				"W_SHADOW_SKIPPED",
				`shadow skipped (${report.skipped.reason}): ${report.skipped.message}`,
			),
		);
	}

	session.warn(report.warnings);
	writeReport(session, flags, report);

	const open = unlabelled(report.rows).length;
	if (flags.strict && open > 0) {
		throw cliCodes.error(
			"E_SHADOW_MISMATCH",
			`${count(open, "unlabelled row")} (--strict)`,
		);
	}
};
