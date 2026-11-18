import { definePlugin } from "@tallyrelease/core";
import { z } from "zod";

import { moduleCalls, moduleCallsJson } from "./hcl.js";
import { edgeBetween } from "../_kit/edges.js";
import {
	dirOf,
	escapeGlob,
	globIn,
	isInside,
	pathUnitId,
	resolvePath,
} from "../_kit/paths.js";

import type { ModuleCall } from "./hcl.js";
import type { Ctx, EdgeDraft, Unit, UnitDraft } from "@tallyrelease/core";

const optionsSchema = z.strictObject({
	paths: z.array(z.string()).optional(),
});

type Options = z.infer<typeof optionsSchema>;

const EXTENSIONS = ["*.tf", "*.tf.json", "*.tofu", "*.tofu.json"];
const CACHE_DIR = /(^|\/)\.terraform\//;
// Terraform treats only sources starting with ./ or ../ as local paths.
const LOCAL = /^\.\.?\//;

const readCalls = (
	ctx: Ctx<Options>,
	root: string,
	file: string,
): ModuleCall[] => {
	const text = ctx.fs.read(file) ?? "";
	try {
		return file.endsWith(".json") ? moduleCallsJson(text) : moduleCalls(text);
	} catch (error) {
		ctx.log.warn(`${root}: cannot parse ${file}: ${String(error)}`);

		return [];
	}
};

export const terraformPlugin = definePlugin<Options>({
	apiVersion: 1,
	name: "terraform",
	options: optionsSchema,
	discover: (ctx) => {
		const paths = ctx.options.paths ?? ["**"];
		const byRoot = new Map<string, string[]>();
		for (const file of ctx.fs.glob(
			paths.flatMap((p) => EXTENSIONS.map((ext) => globIn(p, ext))),
		)) {
			if (CACHE_DIR.test(file)) {
				continue;
			}

			const root = dirOf(file);
			byRoot.set(root, [...(byRoot.get(root) ?? []), file]);
		}

		return [...byRoot].map(([root, files]): UnitDraft => {
			const modules: ModuleCall[] = [];
			const extra = new Set<string>();

			for (const call of files.flatMap((f) => readCalls(ctx, root, f))) {
				if (!LOCAL.test(call.source)) {
					continue;
				}

				const target = resolvePath(root, call.source);
				if (target === undefined) {
					ctx.log.warn(
						`${root}: module "${call.name}" source "${call.source}" leaves the repository`,
					);
				} else if (byRoot.has(target)) {
					if (target !== root) {
						modules.push(call);
					}
				} else if (isInside(target, root)) {
					continue;
				} else if (ctx.fs.exists(target)) {
					extra.add(escapeGlob(target));
					extra.add(`${escapeGlob(target)}/**`);
				} else {
					ctx.log.warn(
						`${root}: module "${call.name}" source "${call.source}" does not exist`,
					);
				}
			}

			return {
				id: pathUnitId(root, ctx.repo.name),
				root,
				...(extra.size > 0 && {
					include: [root === "." ? "**" : `${escapeGlob(root)}/**`, ...extra],
				}),
				meta: { modules },
			};
		});
	},
	edges: (_ctx, units) => {
		const own = units.filter((u) => u.plugin === "terraform");
		const byRoot = new Map<string, Unit>(own.map((u) => [u.root, u]));

		const edges: EdgeDraft[] = [];
		for (const to of own) {
			const modules = (to.meta["terraform"]?.["modules"] ?? []) as ModuleCall[];
			for (const { name, source } of modules) {
				const target = resolvePath(to.root, source);
				const from = target === undefined ? undefined : byRoot.get(target);
				edges.push(
					...edgeBetween(from, to, {
						reason: `module.${name}: ${source}`,
						pinned: false,
					}),
				);
			}
		}

		return edges;
	},
});
