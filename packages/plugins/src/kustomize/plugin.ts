import { defaultUnitId, definePlugin } from "@tallyrelease/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { edgeBetween } from "../_kit/edges.js";
import { globIn } from "../_kit/paths.js";

import type { Ctx, EdgeDraft, Unit, UnitDraft } from "@tallyrelease/core";

const optionsSchema = z.strictObject({
	paths: z.array(z.string()).optional(),
});

type Options = z.infer<typeof optionsSchema>;

type Kustomization = Record<string, unknown>;

interface Ref {
	field: string;
	path: string;
	/** Not warned about when missing, for example a chart home fetched at build time. */
	optional?: boolean;
}

const FILE_NAMES = ["kustomization.yaml", "kustomization.yml", "Kustomization"];
const GLOB_META = /[[\]{}()!*?+@\\]/g;
const REMOTE = /:\/\/|^git@|^github\.com\/|\?ref=/;

const escapeGlob = (path: string): string => path.replace(GLOB_META, "\\$&");

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const strings = (value: unknown): string[] =>
	list(value).filter((v): v is string => typeof v === "string");

const objects = (value: unknown): Kustomization[] =>
	list(value).filter(
		(v): v is Kustomization => typeof v === "object" && v !== null,
	);

/** Joins `rel` onto `root` and normalizes; undefined when it leaves the repo. */
const resolve = (root: string, rel: string): string | undefined => {
	const out: string[] = [];
	for (const part of [...root.split("/"), ...rel.split("/")]) {
		if (part === "..") {
			if (out.pop() === undefined) {
				return undefined;
			}
		} else if (part !== "" && part !== ".") {
			out.push(part);
		}
	}

	return out.length === 0 ? "." : out.join("/");
};

const isInside = (path: string, root: string): boolean =>
	root === "." || path === root || path.startsWith(`${root}/`);

/** Local path references of a kustomization, relative to its directory. */
const extractRefs = (k: Kustomization): Ref[] => {
	const refs: Ref[] = [];
	const add = (field: string, path: unknown, optional?: boolean) => {
		if (typeof path === "string" && path !== "") {
			refs.push(optional ? { field, path, optional } : { field, path });
		}
	};

	// Entries with a newline are inline YAML, not paths.
	const addPaths = (field: string, value: unknown) => {
		for (const path of strings(value).filter((s) => !s.includes("\n"))) {
			add(field, path);
		}
	};

	for (const field of [
		"resources",
		"bases",
		"components",
		"crds",
		"patchesStrategicMerge",
		"configurations",
		"transformers",
		"generators",
		"validators",
	]) {
		addPaths(field, k[field]);
	}

	for (const field of ["patches", "patchesJson6902", "replacements"]) {
		for (const entry of objects(k[field])) {
			add(`${field}.path`, entry["path"]);
		}
	}

	add("openapi.path", (k["openapi"] as Kustomization | undefined)?.["path"]);

	for (const field of ["configMapGenerator", "secretGenerator"]) {
		for (const gen of objects(k[field])) {
			for (const file of strings(gen["files"])) {
				add(`${field}.files`, file.replace(/^[^=]*=/, ""));
			}

			addPaths(`${field}.envs`, gen["envs"]);
			add(`${field}.env`, gen["env"]);
		}
	}

	const charts = objects(k["helmCharts"]);
	for (const chart of charts) {
		add("helmCharts.valuesFile", chart["valuesFile"]);
		addPaths(
			"helmCharts.additionalValuesFiles",
			chart["additionalValuesFiles"],
		);
	}

	if (charts.length > 0) {
		const globals = k["helmGlobals"] as Kustomization | undefined;
		const home = globals?.["chartHome"];
		add(
			"helmGlobals.chartHome",
			typeof home === "string" ? home : "charts",
			true,
		);
	}

	return refs;
};

const readKustomization = (
	ctx: Ctx<Options>,
	root: string,
	file: string,
): Kustomization => {
	try {
		const doc = parseYaml(ctx.fs.read(file) ?? "") as unknown;

		return typeof doc === "object" && doc !== null
			? (doc as Kustomization)
			: {};
	} catch (error) {
		ctx.log.warn(`${root}: cannot parse ${file}: ${String(error)}`);

		return {};
	}
};

const unitId = (root: string, repoName: string): string =>
	root === "." ? defaultUnitId(root, repoName) : root.replaceAll("/", "-");

export const kustomizePlugin = definePlugin<Options>({
	apiVersion: 1,
	name: "kustomize",
	options: optionsSchema,
	discover: (ctx) => {
		const paths = ctx.options.paths ?? ["**"];
		const files = new Map<string, string>();
		for (const file of ctx.fs.glob(
			paths.flatMap((p) => FILE_NAMES.map((name) => globIn(p, name))),
		)) {
			const root = file.includes("/")
				? file.slice(0, file.lastIndexOf("/"))
				: ".";
			if (!files.has(root)) {
				files.set(root, file);
			}
		}

		const roots = new Set(files.keys());

		return [...files].map(([root, file]): UnitDraft => {
			const refs: { path: string; field: string }[] = [];
			const extra = new Set<string>();

			for (const ref of extractRefs(readKustomization(ctx, root, file))) {
				if (REMOTE.test(ref.path) || ref.path.startsWith("/")) {
					continue;
				}

				const target = resolve(root, ref.path);
				if (target === undefined) {
					ctx.log.warn(
						`${root}: ${ref.field} "${ref.path}" leaves the repository`,
					);
				} else if (target === root) {
					continue;
				} else if (roots.has(target)) {
					refs.push({ path: ref.path, field: ref.field });
				} else if (isInside(target, root)) {
					continue;
				} else if (ref.optional || ctx.fs.exists(target)) {
					extra.add(escapeGlob(target));
					extra.add(`${escapeGlob(target)}/**`);
				} else {
					ctx.log.warn(`${root}: ${ref.field} "${ref.path}" does not exist`);
				}
			}

			return {
				id: unitId(root, ctx.repo.name),
				root,
				...(extra.size > 0 && {
					include: [root === "." ? "**" : `${escapeGlob(root)}/**`, ...extra],
				}),
				meta: { refs },
			};
		});
	},
	edges: (_ctx, units) => {
		const own = units.filter((u) => u.plugin === "kustomize");
		const byRoot = new Map<string, Unit>(own.map((u) => [u.root, u]));

		const edges: EdgeDraft[] = [];
		for (const to of own) {
			const refs = (to.meta["kustomize"]?.["refs"] ?? []) as {
				path: string;
				field: string;
			}[];
			for (const { path, field } of refs) {
				const target = resolve(to.root, path);
				const from = target === undefined ? undefined : byRoot.get(target);
				edges.push(
					...edgeBetween(from, to, {
						reason: `${field}: ${path}`,
						pinned: false,
					}),
				);
			}
		}

		return edges;
	},
});
