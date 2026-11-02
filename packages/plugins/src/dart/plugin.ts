import { defaultUnitId, definePlugin } from "@tallyrelease/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { edgeBetween, unitsByPackage } from "../_kit/edges.js";
import { joinRoot, rootOf } from "../_kit/paths.js";
import { BUILD, NUMBERS, PRERELEASE } from "../_kit/semver.js";

import type { Ctx, EdgeDraft, UnitDraft } from "@tallyrelease/core";

const optionsSchema = z.strictObject({});

type Options = z.infer<typeof optionsSchema>;

type Pubspec = Record<string, unknown>;

const PUBSPEC = "pubspec.yaml";
const MELOS = "melos.yaml";
const DEP_FIELDS = [
	"dependencies",
	"dev_dependencies",
	"dependency_overrides",
] as const;
const VERSION = `${NUMBERS}${PRERELEASE}${BUILD}`;
const EXACT = new RegExp(`^${VERSION}$`);
/** An exact `name: version` entry; the groups are the indent, name, colon, quote and trailing text. */
const PIN_LINE = new RegExp(
	`^([ \\t]+)([\\w.-]+)(:[ \\t]*)(["']?)${VERSION}\\4(?=\\s|$)(.*)$`,
);
/** The top-level `version:` line; group 3 is the value without quotes. */
const VERSION_LINE = /^(version:[ \t]*)(["']?)([^\s"'#]+)\2/m;

const record = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};

const readPubspec = (ctx: Ctx<Options>, root: string): Pubspec | undefined => {
	const path = joinRoot(root, PUBSPEC);
	const raw = ctx.fs.read(path);
	if (raw === undefined) {
		return undefined;
	}

	try {
		return record(parseYaml(raw));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`invalid YAML in ${path}: ${reason}`, { cause: error });
	}
};

/** Directories whose pubspecs are never units. */
const SKIPPED = new Set(["build", "example"]);

/** A root pubspec that only anchors a pub workspace or melos setup, without its own version. */
const isWorkspaceRoot = (ctx: Ctx<Options>): boolean => {
	const pubspec = readPubspec(ctx, ".");

	return (
		pubspec !== undefined &&
		pubspec["version"] === undefined &&
		(pubspec["workspace"] !== undefined || ctx.fs.exists(MELOS))
	);
};

/** Roots of every `pubspec.yaml`, skipping dot, `build` and `example` directories and a workspace root. */
const pubspecRoots = (ctx: Ctx<Options>): string[] => {
	const skipRoot = isWorkspaceRoot(ctx);

	return ctx.fs
		.glob([PUBSPEC, `**/${PUBSPEC}`])
		.filter((p) =>
			p
				.split("/")
				.slice(0, -1)
				.every((s) => !s.startsWith(".") && !SKIPPED.has(s)),
		)
		.map((p) => (p === PUBSPEC ? "." : rootOf(p, PUBSPEC)))
		.filter((root) => !(skipRoot && root === "."));
};

/**
 * Whether a dependency entry makes the dependent ship the dependency's code:
 * `path:` maps and exact versions under `dependencies`. Undefined when the
 * entry is no link to a unit.
 */
const pinnedLink = (field: string, spec: unknown): boolean | undefined => {
	if (spec === null) {
		return false;
	}

	if (typeof spec === "string") {
		return field === "dependencies" && EXACT.test(spec);
	}

	return typeof record(spec)["path"] === "string"
		? field === "dependencies"
		: undefined;
};

/** Sets the exact version entries under top-level `dependencies:` that name a released package. */
const rewritePins = (
	content: string,
	released: ReadonlyMap<string, string>,
): string => {
	let inDeps = false;
	let indent: string | undefined;

	return content.replace(/^.*$/gm, (line) => {
		if (/^dependencies:\s*(#.*)?$/.test(line)) {
			inDeps = true;
			indent = undefined;

			return line;
		}

		if (!inDeps || /^\s*(#.*)?$/.test(line)) {
			return line;
		}

		if (!/^\s/.test(line)) {
			inDeps = false;

			return line;
		}

		const [, lead = "", name = "", colon = "", quote = "", rest = ""] =
			PIN_LINE.exec(line) ?? [];
		const version = released.get(name);
		indent ??= /^[ \t]*/.exec(line)?.[0];
		if (version === undefined || lead !== indent) {
			return line;
		}

		return `${lead}${name}${colon}${quote}${version}${quote}${rest}`;
	});
};

export const dartPlugin = definePlugin<Options>({
	apiVersion: 1,
	name: "dart",
	options: optionsSchema,
	discover: (ctx) =>
		pubspecRoots(ctx).map((root): UnitDraft => {
			const pubspec = readPubspec(ctx, root) ?? {};
			const packageName = pubspec["name"];

			return {
				id: defaultUnitId(root, ctx.repo.name),
				root,
				version: "file",
				meta: typeof packageName === "string" ? { packageName } : {},
			};
		}),
	edges: (ctx, units) => {
		const byName = unitsByPackage(units, "dart", (name, prior, unit) => {
			ctx.log.warn(
				`package "${name}" is declared by "${prior.root}" and "${unit.root}"; using "${unit.root}"`,
			);
		});

		const edges: EdgeDraft[] = [];
		for (const to of byName.values()) {
			const pubspec = readPubspec(ctx, to.root) ?? {};
			for (const field of DEP_FIELDS) {
				for (const [name, spec] of Object.entries(record(pubspec[field]))) {
					const pinned = pinnedLink(field, spec);
					if (pinned !== undefined) {
						edges.push(
							...edgeBetween(byName.get(name), to, {
								reason: `${field}: ${name}`,
								pinned,
							}),
						);
					}
				}
			}
		}

		return edges;
	},
	versionFiles: (_ctx, unit) => [
		{
			path: joinRoot(unit.root, PUBSPEC),
			read: (content) => VERSION_LINE.exec(content)?.[3],
			write: (content, next, { units, versions }) => {
				const released = new Map<string, string>();
				for (const u of units) {
					const name = u.meta["dart"]?.["packageName"];
					const version = versions.get(u.id);
					if (typeof name === "string" && version !== undefined) {
						released.set(name, version);
					}
				}

				// A pubspec without a version line gets one after `name:`.
				const versioned = VERSION_LINE.test(content)
					? content.replace(
							VERSION_LINE,
							(_, key: string, quote: string) =>
								`${key}${quote}${next}${quote}`,
						)
					: content.replace(
							/^name:.*$/m,
							(line) =>
								`${line}${content.includes("\r\n") ? "\r\n" : "\n"}version: ${next}`,
						);

				return rewritePins(versioned, released);
			},
		},
	],
	inputs: (ctx) => ({
		global: [
			"pubspec.lock",
			MELOS,
			"analysis_options.yaml",
			...(isWorkspaceRoot(ctx) ? [PUBSPEC] : []),
		],
	}),
});
