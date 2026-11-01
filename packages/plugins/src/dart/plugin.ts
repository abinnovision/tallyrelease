import { defaultUnitId, definePlugin } from "@tallyrelease/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { edgeBetween, unitsByPackage } from "../_kit/edges.js";
import { joinRoot, rootOf } from "../_kit/paths.js";

import type { Ctx, EdgeDraft, UnitDraft } from "@tallyrelease/core";

const optionsSchema = z.strictObject({});

type Options = z.infer<typeof optionsSchema>;

type Pubspec = Record<string, unknown>;

const PUBSPEC = "pubspec.yaml";
const DEP_FIELDS = [
	"dependencies",
	"dev_dependencies",
	"dependency_overrides",
] as const;
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

/** Roots of every `pubspec.yaml`, skipping dot, `build` and `example` directories. */
const pubspecRoots = (ctx: Ctx<Options>): string[] =>
	ctx.fs
		.glob([PUBSPEC, `**/${PUBSPEC}`])
		.filter((p) =>
			p
				.split("/")
				.slice(0, -1)
				.every((s) => !s.startsWith(".") && !SKIPPED.has(s)),
		)
		.map((p) => (p === PUBSPEC ? "." : rootOf(p, PUBSPEC)));

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
		const byName = unitsByPackage(units, "dart");

		const edges: EdgeDraft[] = [];
		for (const to of byName.values()) {
			const pubspec = readPubspec(ctx, to.root) ?? {};
			for (const field of DEP_FIELDS) {
				for (const [name, spec] of Object.entries(record(pubspec[field]))) {
					if (typeof record(spec)["path"] === "string") {
						edges.push(
							...edgeBetween(byName.get(name), to, {
								reason: `${field}: ${name}`,
								pinned: false,
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
			// A pubspec without a version line gets one after `name:`.
			write: (content, next) =>
				VERSION_LINE.test(content)
					? content.replace(
							VERSION_LINE,
							(_, key: string, quote: string) =>
								`${key}${quote}${next}${quote}`,
						)
					: content.replace(
							/^name:.*$/m,
							(line) => `${line}\nversion: ${next}`,
						),
		},
	],
	inputs: () => ({ global: ["pubspec.lock"] }),
});
