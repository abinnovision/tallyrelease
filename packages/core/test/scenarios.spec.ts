import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { changelogSection } from "../src/changelog.js";
import { collectPlanFacts } from "../src/facts.js";
import {
	buildNumbers,
	computeAffected,
	computePlan,
	cutChanges,
	cutEquals,
	cutWarnings,
	loadWorkspace,
	planEquals,
	releaseFiles,
	releaseItems,
	releaseNotes,
	withReleased,
} from "../src/index.js";
import { flutter } from "./fixtures/flutter.js";
import { memoryFs, memoryGit } from "../src/testing/index.js";

import type {
	Change,
	EdgeDraft,
	GitReader,
	MarkerRelease,
	Plan,
	Plugin,
	ReadonlyFs,
	ReleaseItem,
	TallyConfig,
	UnitDraft,
	Workspace,
} from "../src/index.js";
import type { Dag } from "../src/testing/index.js";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/** Declarative plugin stub; every hook resolves asynchronously. */
interface Stub {
	name: string;
	apiVersion?: number;
	units?: UnitDraft[];
	edges?: EdgeDraft[];
	inputs?: string[];
	/** Accepted option keys; any other key is a validation issue. */
	optionKeys?: string[];
	throws?: "discover" | "edges" | "inputs" | "validate";
	schemes?: (keyof typeof SCHEMES)[];
	/** Returned by an intent source for every range. */
	changes?: Change[];
	/** Returned by `validate`. */
	validate?: string[];
	/** Section returned by `changelog`. */
	changelog?: string;
	/** Version file paths by unit id; `write` puts the version on one line. */
	versionFiles?: Record<string, string[]>;
}

const SCHEMES = { flutter };

interface Scenario {
	description: string;
	repo?: string;
	plugins?: Stub[];
	/** `plugins` defaults to every stub with empty options. */
	config?: TallyConfig;
	/** Passed as `loadWorkspace({ configFile })`. */
	configFile?: string;
	git: Dag;
	base: string | null;
	/** Defaults to the last commit. */
	head?: string;
	/** Defaults to `main`. */
	branch?: string;
	/**
	 * Collects plan facts and computes the plan when set; with `fails` a plan
	 * error is returned as `planError`; `released` fills `plan.released`;
	 * `buildNumbers` numbers the releases, then the prereleases not released at
	 * HEAD, in the order of the release list; `buildChannel` selects the
	 * build prerelease channel.
	 */
	plan?: {
		all?: boolean;
		buildChannel?: "build" | "nightly";
		fails?: boolean;
		released?: boolean;
		buildNumbers?: boolean;
	};
	/**
	 * With `plan`: release items, `planEquals` per marker, the changelog
	 * section of each unit with a stable `next` and `releaseFiles` of all items
	 * (`files`, `paths`, `deletes`) with the `releaseNotes` of each unit.
	 */
	release?: {
		markers?: Record<string, MarkerRelease[]>;
		changelog?: { date: string; repoUrl?: string };
		files?: { date?: string; repoUrl?: string; changelogs?: boolean };
		/**
		 * Cut items, `cutWarnings` and `previousCut` from `cutChanges`;
		 * `changelog` renders the `releaseFiles` cut sections as
		 * `cutChangelogs` and `files` runs `releaseFiles` with `{ cut }`.
		 */
		cut?: boolean;
		/** Plans this commit too and evaluates `cutEquals` per marker, with `head` as P. */
		markerHead?: string;
	};
	expect?: Record<string, unknown>;
	error?: { code: string; details?: Record<string, unknown> };
}

const keysSchema = (
	keys: string[],
): StandardSchemaV1<unknown, Record<string, unknown>> => ({
	"~standard": {
		version: 1,
		vendor: "scenario",
		validate: (value) => {
			const options = value as Record<string, unknown>;
			const unknown = Object.keys(options).filter((k) => !keys.includes(k));

			return unknown.length > 0
				? { issues: unknown.map((k) => ({ message: `unknown option "${k}"` })) }
				: { value: options };
		},
	},
});

const stubPlugin = (stub: Stub): Plugin => {
	const hook =
		<T>(name: NonNullable<Stub["throws"]>, value: T) =>
		async (): Promise<T> => {
			if (stub.throws === name) {
				throw new Error(`${name} failed`);
			}

			return await Promise.resolve(value);
		};

	return {
		apiVersion: stub.apiVersion as 1,
		name: stub.name,
		...(stub.optionKeys && { options: keysSchema(stub.optionKeys) }),
		discover: hook("discover", stub.units ?? []),
		edges: hook("edges", stub.edges ?? []),
		inputs: hook("inputs", { global: stub.inputs ?? [] }),
		validate: hook("validate", stub.validate),
		...(stub.changelog !== undefined && {
			changelog: () => stub.changelog ?? "",
		}),
		...(stub.schemes && {
			schemes: Object.fromEntries(stub.schemes.map((n) => [n, SCHEMES[n]])),
		}),
		...(stub.changes && {
			intent: [{ name: "stub", collect: () => stub.changes ?? [] }],
		}),
		...(stub.versionFiles && {
			versionFiles: (_, unit) =>
				(stub.versionFiles?.[unit.id] ?? []).map((path) => ({
					path,
					read: (content) => content.trim(),
					write: (_content, next) => `${next}\n`,
				})),
		}),
	};
};

const prOf = (item: ReleaseItem) =>
	item.mode === "shared" ? "shared" : item.name;

/**
 * Cut items with their `cutChanges` and the cut outputs; with `changelog`,
 * the `releaseFiles` cut sections as `cutChangelogs`.
 */
const cutRelease = async (
	workspace: Workspace,
	plan: Plan,
	{
		git,
		fs,
		changelog,
	}: {
		git: GitReader;
		fs: ReadonlyFs;
		changelog: { date: string; repoUrl?: string } | undefined;
	},
) => {
	const items = releaseItems(workspace, plan, { cut: true });
	const changes = await cutChanges(workspace, plan, { items, git });
	const sections =
		changelog &&
		(
			await releaseFiles(workspace, plan, {
				fs,
				items,
				repoUrl: changelog.repoUrl ?? null,
				date: changelog.date,
				cut: changes,
			})
		).sections;

	return {
		items,
		changes,
		output: {
			cutItems: items,
			cutWarnings: cutWarnings(plan),
			previousCut: Object.fromEntries(
				[...changes].map(([id, c]) => [id, c.previousCut?.name ?? null]),
			),
			...(sections && { cutChangelogs: Object.fromEntries(sections) }),
		},
	};
};

/** Files and workspace of the scenario at commit `at`. */
const loadAt = async (
	s: Scenario,
	git: ReturnType<typeof memoryGit>,
	at: string,
) => {
	const stubs = (s.plugins ?? []).map((p) => ({ apiVersion: 1, ...p }));
	const fs = memoryFs(git.tree(at));
	const workspace = await loadWorkspace({
		config: s.config ?? {
			plugins: Object.fromEntries(stubs.map((p) => [p.name, {}])),
		},
		plugins: stubs.map(stubPlugin),
		fs,
		repo: { name: s.repo ?? "demo" },
		...(s.configFile !== undefined && { configFile: s.configFile }),
	});

	return { fs, workspace };
};

/**
 * `cutEquals` per marker with the plan at `release.markerHead` and `atP`;
 * undefined without a marker head.
 */
const cutEqualsAt = async (
	s: Scenario,
	git: ReturnType<typeof memoryGit>,
	opts: Omit<Parameters<typeof computePlan>[2], "fs" | "all">,
	atP: { workspace: Workspace; plan: Plan },
) => {
	const at = s.release?.markerHead;
	if (at === undefined) {
		return undefined;
	}

	const { fs, workspace } = await loadAt(s, git, at);
	const atH = {
		workspace,
		plan: await computePlan(workspace, git, {
			...opts,
			head: at,
			fs,
			all: s.plan?.all ?? false,
		}),
	};

	return Object.fromEntries(
		Object.entries(s.release?.markers ?? {}).map(([name, marker]) => [
			name,
			cutEquals(marker, atH, atP),
		]),
	);
};

const run = async (s: Scenario) => {
	const git = memoryGit(s.git);
	const head = s.head ?? s.git.commits.at(-1)?.id ?? "HEAD";
	const { fs, workspace } = await loadAt(s, git, head);
	const opts = {
		tool: "tallyrelease@test",
		branch: s.branch ?? "main",
		head,
		base: s.base,
		baseSource: s.base === null ? ("none" as const) : ("cli" as const),
	};
	const affected = await computeAffected(workspace, git, opts);

	const facts = s.plan
		? await collectPlanFacts(workspace, git, { head, fs })
		: undefined;
	let planError: unknown;
	const plan = s.plan
		? await computePlan(workspace, git, {
				...opts,
				fs,
				all: s.plan.all ?? false,
				...(s.plan.buildChannel && { buildChannel: s.plan.buildChannel }),
			})
				.then(async (p) =>
					s.plan?.released ? await withReleased(workspace, p, { git }) : p,
				)
				.catch((error: unknown) => {
					if (!s.plan?.fails) {
						throw error;
					}

					planError = error;

					return undefined;
				})
		: undefined;

	const atHead = new Set(
		plan?.released.filter((r) => r.releaseSha === plan.head).map((r) => r.id),
	);
	const numbered =
		plan &&
		s.plan?.buildNumbers &&
		(await buildNumbers(
			workspace,
			[
				...plan.released.map((r) => ({ id: r.id, sha: r.releaseSha })),
				...plan.units
					.filter(
						(u) =>
							u.kind === "prerelease" &&
							u.version !== null &&
							!atHead.has(u.id),
					)
					.map((u) => ({ id: u.id, sha: plan.head })),
			],
			{ git, line: plan.line?.kind ?? "default" },
		));

	const { markers = {}, changelog, files, cut } = s.release ?? {};
	const stableItems = plan ? releaseItems(workspace, plan) : [];
	const cutRun =
		plan && cut
			? await cutRelease(workspace, plan, { git, fs, changelog })
			: undefined;
	const items = cutRun ? cutRun.items : stableItems;

	const prUnits = (id: string) => {
		const own = items.find((i) => i.units.includes(id));

		return items
			.filter((i) => own && prOf(i) === prOf(own))
			.flatMap((i) => i.units);
	};

	const written =
		plan && files
			? await releaseFiles(workspace, plan, {
					fs,
					items,
					...files,
					...(cutRun && { cut: cutRun.changes }),
				})
			: undefined;

	const release = plan &&
		s.release && {
			items: stableItems,
			cutEquals: await cutEqualsAt(s, git, opts, { workspace, plan }),
			...(written && {
				files: Object.fromEntries(written.files),
				paths: [...written.files.keys()].sort(),
				deletes: [...written.deletes].sort(),
				fileWarnings: written.warnings,
				notes: Object.fromEntries(
					plan.units.map((u) => [
						u.id,
						releaseNotes(
							workspace,
							u.id,
							(path) => written.files.get(path) ?? fs.read(path),
						),
					]),
				),
			}),
			equals: Object.fromEntries(
				Object.entries(markers).map(([name, marker]) => [
					name,
					planEquals(marker, plan, workspace),
				]),
			),
			changelogs: Object.fromEntries(
				plan.units.flatMap((u) => {
					const text =
						changelog &&
						changelogSection(workspace, plan, {
							id: u.id,
							repoUrl: changelog.repoUrl ?? null,
							date: changelog.date,
							prUnits: prUnits(u.id),
						});

					return text === undefined ? [] : [[u.id, text]];
				}),
			),
			...cutRun?.output,
		};

	return {
		...release,
		units: workspace.units,
		edges: workspace.graph.edges,
		order: workspace.graph.order,
		affected,
		facts,
		plan,
		planError,
		...(numbered && { buildNumbers: numbered }),
	};
};

const dir = join(import.meta.dirname, "scenarios");
const cases = readdirSync(dir)
	.filter((f) => f.endsWith(".yaml"))
	.map((file) => {
		const scenario = parse(readFileSync(join(dir, file), "utf8")) as Scenario;
		const expected = scenario.error
			? { error: scenario.error }
			: { value: scenario.expect ?? {} };

		return {
			name: `${file.replace(/\.yaml$/, "")}: ${scenario.description}`,
			scenario,
			expected,
		};
	});

describe("scenarios", () => {
	for (const { name, scenario, expected } of cases) {
		it(name, async () => {
			const outcome = await run(scenario).then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);
			expect(outcome).toMatchObject(expected);
		});
	}
});
