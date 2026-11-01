import {
	changelogPath,
	changelogSection,
	headingVersion,
	updateChangelog,
} from "./changelog.js";
import { coreCodes } from "./codes.js";
import { normalizeRoot } from "./discover.js";
import { pluginCtx, runHook } from "./plugins.js";
import { frozenCopy } from "./util.js";

import type { Warning } from "./errors.js";
import type { Plan } from "./model/plan-types.js";
import type {
	Ctx,
	ReadonlyFs,
	Unit,
	VersionFile,
	VersionScheme,
} from "./plugin.js";
import type { ReleaseItem } from "./release-items.js";
import type { Workspace } from "./workspace.js";

type CoreToken = "major" | "minor" | "patch";
type VersionToken = CoreToken | "version";

const TOKEN = /\{([^{}]*)\}/gu;
const SPECIAL = /[\\^$.*+?()[\]{}|/]/gu;
const CORE_TOKENS: readonly CoreToken[] = ["major", "minor", "patch"];
const VERSION =
	"\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";

const ALNUM = /[0-9A-Za-z]/u;
const MARKERS = ["# x-tallyrelease-version", "<!-- x-tallyrelease-version -->"];
const WORD = /[0-9A-Za-z](?:[0-9A-Za-z.+-]*[0-9A-Za-z])?/gu;

const escape = (text: string) => text.replace(SPECIAL, "\\$&");

const configError = (pattern: string, unit: string, problem: string) =>
	coreCodes.error(
		"E_CONFIG",
		`version file pattern "${pattern}" of unit "${unit}" ${problem}`,
		{ unit, pattern },
	);

/**
 * Compiles a template pattern: literal parts escaped, `{id}` literal, version
 * tokens captured. An edge that is a token or an alphanumeric literal must not
 * touch another alphanumeric, and the end must not be followed by `.<digit>`.
 * Throws `E_CONFIG` for an unknown token, no version token, `{version}` mixed
 * with `{major}`, `{minor}` or `{patch}` (their values could disagree), or no
 * literal text.
 */
const compileTemplate = (
	pattern: string,
	unit: string,
): { re: RegExp; tokens: VersionToken[] } => {
	const tokens: VersionToken[] = [];
	let source = "";
	let literal = false;
	let last = 0;
	for (const m of pattern.matchAll(TOKEN)) {
		const text = pattern.slice(last, m.index);
		literal ||= text !== "";
		source += escape(text);
		last = m.index + m[0].length;
		const token = m[1] ?? "";
		if (token === "id") {
			source += escape(unit);
		} else if (token === "version") {
			tokens.push(token);
			source += `(${VERSION})`;
		} else if ((CORE_TOKENS as readonly string[]).includes(token)) {
			tokens.push(token as CoreToken);
			source += "(\\d+)";
		} else {
			throw configError(
				pattern,
				unit,
				`uses unknown token "${m[0]}"; use {id}, {version}, {major}, {minor} or {patch}`,
			);
		}
	}

	const tail = pattern.slice(last);
	literal ||= tail !== "";
	source += escape(tail);
	if (tokens.length === 0) {
		throw configError(pattern, unit, "has no version token");
	}

	if (tokens.includes("version") && tokens.some((t) => t !== "version")) {
		throw configError(
			pattern,
			unit,
			"mixes {version} with {major}, {minor} or {patch}",
		);
	}

	if (!literal) {
		throw configError(pattern, unit, "has no literal text");
	}

	const bounded = (edge: string | undefined, brace: string) =>
		edge === brace || ALNUM.test(edge ?? "");
	const before = bounded(pattern.at(0), "{") ? "(?<![0-9A-Za-z])" : "";
	const after = bounded(pattern.at(-1), "}")
		? "(?![0-9A-Za-z]|\\.\\d)"
		: "(?!\\.\\d)";

	return { re: new RegExp(`${before}${source}${after}`, "gu"), tokens };
};

/**
 * Replaces each match of `pattern` whose captured values render a version `v`
 * with `from <= v < next` (compared over the tokens present) by the rendering
 * of `next`. `hit` is false when the pattern matches nothing.
 */
const applyTemplate = <V>(
	content: string,
	{
		pattern,
		unit,
		from,
		next,
		scheme,
	}: {
		pattern: string;
		unit: string;
		from: string;
		next: string;
		scheme: VersionScheme<V>;
	},
): { content: string; hit: boolean } => {
	const { re, tokens } = compileTemplate(pattern, unit);
	const low = scheme.parse(from);
	const high = scheme.parse(next);
	if (low === undefined || high === undefined) {
		throw new Error(`"${from}" or "${next}" is not a version of the scheme`);
	}

	const present = CORE_TOKENS.filter((t) => tokens.includes(t));
	const key = (v: V) => present.map((t) => scheme.core(v)[t]);
	const compareKeys = (a: number[], b: number[]) =>
		a.reduce((c, n, i) => c || n - (b[i] ?? 0), 0);
	const rendered = pattern.replace(TOKEN, (_, token: string) =>
		token === "id"
			? unit
			: token === "version"
				? next
				: String(scheme.core(high)[token as CoreToken]),
	);

	let hit = false;
	const replaced = content.replace(re, (match, ...groups: unknown[]) => {
		const values = new Map<VersionToken, string>();
		for (const [i, token] of tokens.entries()) {
			const value = String(groups[i]);
			if ((values.get(token) ?? value) !== value) {
				return match;
			}

			values.set(token, value);
		}

		const raw = values.get("version");
		const v = raw === undefined ? undefined : scheme.parse(raw);
		if (raw !== undefined && v === undefined) {
			return match;
		}

		hit = true;
		const found = () => present.map((t) => Number(values.get(t)));
		const inRange =
			v === undefined
				? compareKeys(found(), key(low)) >= 0 &&
					compareKeys(found(), key(high)) < 0
				: scheme.compare(v, low) >= 0 && scheme.compare(v, high) < 0;

		return inRange ? rendered : match;
	});

	return { content: replaced, hit };
};

/**
 * Replaces, on each marker line, the first word the scheme parses (after an
 * optional `v`) with `next`. `hit` is false when no marker line has one.
 */
const applyMarkers = (
	content: string,
	{ next, scheme }: { next: string; scheme: VersionScheme<unknown> },
): { content: string; hit: boolean } => {
	let hit = false;
	const lines = content.split("\n").map((line) => {
		if (!MARKERS.some((m) => line.includes(m))) {
			return line;
		}

		for (const m of line.matchAll(WORD)) {
			const [word] = m;
			const start =
				word.startsWith("v") && scheme.parse(word.slice(1)) !== undefined
					? m.index + 1
					: scheme.parse(word) !== undefined
						? m.index
						: undefined;
			if (start !== undefined) {
				hit = true;

				return `${line.slice(0, start)}${next}${line.slice(m.index + word.length)}`;
			}
		}

		return line;
	});

	return { content: lines.join("\n"), hit };
};

/** Repo-relative template file; `E_CONFIG` for `.`, absolute or `..` paths. */
const templateFile = (file: string, unit: string): string => {
	const invalid = () =>
		coreCodes.error(
			"E_CONFIG",
			`version file "${file}" of unit "${unit}" must be a repo-relative file without ".." segments`,
			{ unit, file },
		);
	let path: string;
	try {
		path = normalizeRoot(file);
	} catch {
		throw invalid();
	}

	if (path === ".") {
		throw invalid();
	}

	return path;
};

/** Files written so far; reads see them before `fs`. */
interface Staged {
	readonly files: Map<string, string>;
	readonly read: (path: string) => string | undefined;
}

/** One unit of one release item. */
interface UnitStep {
	workspace: Workspace;
	plan: Plan;
	item: ReleaseItem;
	unit: Unit;
	scheme: VersionScheme<any>;
	/** Base version of the unit's range; null for a first release. */
	from: string | null;
	/** Next version of every released unit. */
	versions: ReadonlyMap<string, string>;
	/** Units released in the same release PR. */
	prUnits: readonly string[];
	repoUrl: string | null;
	date: string;
	/** Context of a plugin hook. */
	ctx: (plugin: string, options: unknown) => Ctx;
	/** Frozen copy of `plan` for plugin hooks, made on first use. */
	hookPlan: () => Plan;
}

const required = (staged: Staged, path: string, unit: string): string => {
	const content = staged.read(path);
	if (content === undefined) {
		throw coreCodes.error(
			"E_VERSION_FILE_MISSING",
			`version file "${path}" of unit "${unit}" does not exist`,
			{ path, unit },
		);
	}

	return content;
};

/** Writes the plugin version files of the unit. */
const versionFileStep = async (
	staged: Staged,
	step: UnitStep,
	pluginFiles: readonly VersionFile[],
): Promise<void> => {
	const { workspace, item, unit, versions } = step;
	const ctx = { unit, units: workspace.units, versions };
	for (const file of pluginFiles) {
		const content = required(staged, file.path, unit.id);
		// eslint-disable-next-line no-await-in-loop -- files are written in order
		const written = await runHook(unit.plugin, "write", () =>
			file.write(content, item.version, ctx),
		);
		staged.files.set(file.path, written);
	}
};

/**
 * Rewrites the version templates and markers of the unit; templates skip
 * first releases.
 */
const templateStep = (staged: Staged, step: UnitStep): Warning[] => {
	const { workspace, item, unit, scheme, from } = step;
	const warnings: Warning[] = [];
	for (const template of workspace.release.templates.get(unit.id) ?? []) {
		const { pattern } = template;
		const file = templateFile(template.file, unit.id);
		if (pattern === undefined) {
			const result = applyMarkers(required(staged, file, unit.id), {
				next: item.version,
				scheme,
			});
			staged.files.set(file, result.content);
			if (!result.hit) {
				warnings.push(
					coreCodes.warning(
						"W_MARKER_NO_MATCH",
						`version file "${file}" of unit "${unit.id}" has no x-tallyrelease-version marker with a version`,
						{ unit: unit.id },
					),
				);
			}

			continue;
		}

		if (from === null) {
			continue;
		}

		const result = applyTemplate(required(staged, file, unit.id), {
			pattern,
			unit: unit.id,
			from,
			next: item.version,
			scheme,
		});
		staged.files.set(file, result.content);
		if (!result.hit) {
			warnings.push(
				coreCodes.warning(
					"W_VERSION_FILE_NO_MATCH",
					`version file pattern "${pattern}" of unit "${unit.id}" matches nothing in "${file}"`,
					{ unit: unit.id },
				),
			);
		}
	}

	return warnings;
};

/**
 * The owning plugin's `changelog` section, which must have one version
 * heading, of the released version, on its first line; else `section`.
 */
const pluginSection = async (
	step: UnitStep,
	section: string,
): Promise<string> => {
	const { workspace, item, unit, scheme, ctx, hookPlan } = step;
	const owner = workspace.plugins.find((p) => p.plugin.name === unit.plugin);
	const hook = owner?.plugin.changelog;
	if (!owner || !hook) {
		return section;
	}

	return await runHook(unit.plugin, "changelog", async () => {
		const result: unknown = await hook(ctx(unit.plugin, owner.options), {
			unit,
			plan: hookPlan(),
			section,
		});
		if (typeof result !== "string") {
			throw new TypeError("changelog must return a string");
		}

		const text = result.trim();
		const [first = "", ...rest] = text.split("\n");
		const version: unknown = headingVersion(first, scheme);
		const next: unknown = scheme.parse(item.version);
		if (
			version === undefined ||
			next === undefined ||
			scheme.compare(version, next) !== 0 ||
			rest.some((line) => headingVersion(line, scheme) !== undefined)
		) {
			throw new Error(
				`section of unit "${unit.id}" must start with a heading of version ${item.version} and have no other version heading`,
			);
		}

		return text;
	});
};

/** Updates the unit's changelog; returns the new section, if any. */
const changelogStep = async (
	staged: Staged,
	step: UnitStep,
): Promise<string | undefined> => {
	const { workspace, plan, unit, scheme, from, repoUrl, date, prUnits } = step;
	const fallback = changelogSection(workspace, plan, {
		id: unit.id,
		repoUrl,
		date,
		prUnits,
	});
	const section =
		fallback === undefined ? undefined : await pluginSection(step, fallback);
	if (section !== undefined) {
		const path = changelogPath(unit);
		staged.files.set(
			path,
			updateChangelog(staged.read(path), section, {
				baseVersion: from,
				scheme,
			}),
		);
	}

	return section;
};

/** Checks template files and patterns (`E_CONFIG`); runs no plugin hook. */
export const validateTemplates = (workspace: Workspace): void => {
	for (const [id, templates] of workspace.release.templates) {
		for (const { file, pattern } of templates) {
			templateFile(file, id);
			if (pattern !== undefined) {
				compileTemplate(pattern, id);
			}
		}
	}
};

/**
 * Plugin version files by unit id. Throws `E_VERSION_FILE_CLAIM` when a path
 * is a plugin version file of two units or also a template, or a marker file
 * of two units. Templates may share a file.
 */
export const versionFileClaims = async (
	workspace: Workspace,
): Promise<ReadonlyMap<string, readonly VersionFile[]>> => {
	const files = await workspace.versionFiles();
	const claims = new Map<string, string>();
	for (const [id, list] of files) {
		for (const { path } of list) {
			const prior = claims.get(path);
			if (prior !== undefined) {
				throw coreCodes.error(
					"E_VERSION_FILE_CLAIM",
					`version file "${path}" is claimed by units "${prior}" and "${id}"`,
					{ path, units: [prior, id] },
				);
			}

			claims.set(path, id);
		}
	}

	const markers = new Map<string, string>();
	for (const [id, templates] of workspace.release.templates) {
		for (const { file, pattern } of templates) {
			const path = templateFile(file, id);
			const owner = claims.get(path);
			if (owner !== undefined) {
				throw coreCodes.error(
					"E_VERSION_FILE_CLAIM",
					`version file template of unit "${id}" targets "${path}", a version file of unit "${owner}"`,
					{ path, units: [owner, id] },
				);
			}

			if (pattern === undefined) {
				const marked = markers.get(path);
				if (marked !== undefined && marked !== id) {
					throw coreCodes.error(
						"E_VERSION_FILE_CLAIM",
						`version file "${path}" holds markers of units "${marked}" and "${id}"`,
						{ path, units: [marked, id] },
					);
				}

				markers.set(path, id);
			}
		}
	}

	return files;
};

/**
 * Files of a release of `items` (stable `next`): plugin version files,
 * templates, markers and `<root>/CHANGELOG.md` per unit, read through `fs`; the
 * owning plugin's `changelog` hook may replace a unit's section. Returns
 * only files whose content changes, and each unit's changelog section;
 * checks claims first. Templates skip first releases and warn
 * `W_VERSION_FILE_NO_MATCH` without any match, markers warn
 * `W_MARKER_NO_MATCH`; a missing version file is
 * `E_VERSION_FILE_MISSING`.
 */
export const releaseFiles = async (
	workspace: Workspace,
	plan: Plan,
	opts: {
		/** Files the release is based on. */
		fs: ReadonlyFs;
		items: readonly ReleaseItem[];
		repoUrl: string | null;
		/** `YYYY-MM-DD` changelog heading date. */
		date: string;
	},
): Promise<{
	files: Map<string, string>;
	/** Changelog section of each unit, by unit id. */
	sections: Map<string, string>;
	warnings: Warning[];
}> => {
	const { fs, items, repoUrl, date } = opts;
	const pluginFiles = await versionFileClaims(workspace);
	const { schemes } = workspace;
	const units = new Map(workspace.units.map((u) => [u.id, u]));
	const planned = new Map(plan.units.map((u) => [u.id, u]));
	const versions = new Map(
		items.flatMap((i) => i.units.map((id) => [id, i.version] as const)),
	);
	const pr = (item: ReleaseItem) =>
		item.mode === "shared" ? "shared" : item.name;
	const files = new Map<string, string>();
	const staged: Staged = {
		files,
		read: (path) => files.get(path) ?? fs.read(path),
	};
	const sections = new Map<string, string>();
	const warnings: Warning[] = [];
	const ctx = pluginCtx({ fs, repo: { name: workspace.repo } }, warnings);
	let frozen: Plan | undefined;
	const hookPlan = () => (frozen ??= frozenCopy(plan));

	for (const item of items) {
		const prUnits = items
			.filter((i) => pr(i) === pr(item))
			.flatMap((i) => i.units);
		for (const id of item.units) {
			const unit = units.get(id);
			const entry = planned.get(id);
			const scheme = unit && schemes.get(unit.scheme);
			if (!unit || !entry || !scheme) {
				continue;
			}

			const step: UnitStep = {
				workspace,
				plan,
				item,
				unit,
				scheme,
				from: entry.from,
				versions,
				prUnits,
				repoUrl,
				date,
				ctx,
				hookPlan,
			};
			// eslint-disable-next-line no-await-in-loop -- files are written in order
			await versionFileStep(staged, step, pluginFiles.get(id) ?? []);
			warnings.push(...templateStep(staged, step));
			// eslint-disable-next-line no-await-in-loop -- files are written in order
			const section = await changelogStep(staged, step);
			if (section !== undefined) {
				sections.set(id, section);
			}
		}
	}

	return {
		files: new Map([...files].filter(([path, c]) => fs.read(path) !== c)),
		sections,
		warnings,
	};
};
