import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { changelogSection } from "../src/changelog.js";
import { collectPlanFacts } from "../src/facts.js";
import {
	computeAffected,
	computePlan,
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
	MarkerRelease,
	Plugin,
	TallyConfig,
	UnitDraft,
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
	 * error is returned as `planError`; `released` fills `plan.released`.
	 */
	plan?: { all?: boolean; fails?: boolean; released?: boolean };
	/**
	 * With `plan`: release items, `planEquals` per marker, the changelog
	 * section of each unit with a stable `next` and `releaseFiles` of all items
	 * (`files`, `paths`, `deletes`) with the `releaseNotes` of each unit.
	 */
	release?: {
		markers?: Record<string, MarkerRelease[]>;
		changelog?: { date: string; repoUrl?: string };
		files?: { date: string; repoUrl?: string };
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

const run = async (s: Scenario) => {
	const stubs = (s.plugins ?? []).map((p) => ({ apiVersion: 1, ...p }));
	const git = memoryGit(s.git);
	const head = s.head ?? s.git.commits.at(-1)?.id ?? "HEAD";
	const fs = memoryFs(git.tree(head));
	const workspace = await loadWorkspace({
		config: s.config ?? {
			plugins: Object.fromEntries(stubs.map((p) => [p.name, {}])),
		},
		plugins: stubs.map(stubPlugin),
		fs,
		repo: { name: s.repo ?? "demo" },
		...(s.configFile !== undefined && { configFile: s.configFile }),
	});
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

	const { markers = {}, changelog, files } = s.release ?? {};
	const items = plan ? releaseItems(workspace, plan) : [];
	const pr = (item: (typeof items)[number]) =>
		item.mode === "shared" ? "shared" : item.name;
	const prUnits = (id: string) => {
		const own = items.find((i) => i.units.includes(id));

		return items
			.filter((i) => own && pr(i) === pr(own))
			.flatMap((i) => i.units);
	};

	const written =
		plan && files
			? await releaseFiles(workspace, plan, {
					fs,
					items,
					repoUrl: files.repoUrl ?? null,
					date: files.date,
				})
			: undefined;

	const release = plan &&
		s.release && {
			items,
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
