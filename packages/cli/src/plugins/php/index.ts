import { defaultUnitId, definePlugin } from "@tallyrelease/core";

import { parseJson } from "../json.js";

import type { Ctx, EdgeDraft, Unit, UnitDraft } from "@tallyrelease/core";

interface Composer {
	name?: string;
	repositories?: unknown;
	[field: string]: unknown;
}

const EXACT = /^(self\.version|=?v?\d+\.\d+\.\d+(\.\d+)?(-[0-9A-Za-z.-]+)?)$/;

const composerPath = (root: string): string =>
	root === "." ? "composer.json" : `${root}/composer.json`;

const readComposer = (ctx: Ctx, root: string): Composer | undefined => {
	const path = composerPath(root);
	const raw = ctx.fs.read(path);

	return raw === undefined ? undefined : (parseJson(path, raw) as Composer);
};

/** Local `repositories[type=path]` url globs, repo-relative. */
const pathRepoGlobs = (composer: Composer): string[] => {
	const repos = Object.values(
		(composer.repositories ?? {}) as Record<string, unknown>,
	) as { type?: string; url?: string }[];

	return repos
		.filter((r) => r.type === "path" && typeof r.url === "string")
		.map((r) => (r.url ?? "").replace(/^\.\//, "").replace(/\/+$/, ""))
		.filter((url) => url !== "" && !url.startsWith("../"));
};

export const phpPlugin = definePlugin({
	apiVersion: 1,
	name: "php",
	discover: (ctx) => {
		const rootComposer = readComposer(ctx, ".");
		if (!rootComposer) {
			return [];
		}

		const roots = [
			".",
			...ctx.fs
				.glob(pathRepoGlobs(rootComposer).map((u) => `${u}/composer.json`))
				.map((p) => p.slice(0, -"/composer.json".length))
				.filter((root) => root !== ""),
		];

		return roots.map((root): UnitDraft => {
			const packageName = readComposer(ctx, root)?.name;

			return {
				id: defaultUnitId(root, ctx.repo.name),
				root,
				version: "tag",
				meta: packageName === undefined ? {} : { packageName },
			};
		});
	},
	edges: (ctx, units) => {
		const byName = new Map<string, Unit>();
		for (const unit of units) {
			const name = unit.meta["php"]?.["packageName"];
			if (unit.plugin === "php" && typeof name === "string") {
				byName.set(name, unit);
			}
		}

		const edges: EdgeDraft[] = [];
		for (const to of byName.values()) {
			const composer = readComposer(ctx, to.root) ?? {};
			for (const field of ["require", "require-dev"] as const) {
				const deps = (composer[field] ?? {}) as Record<string, string>;
				for (const [name, constraint] of Object.entries(deps)) {
					const from = byName.get(name);
					if (from && from.id !== to.id) {
						edges.push({
							from: from.id,
							to: to.id,
							reason: `${field}: ${name}`,
							pinned: field === "require" && EXACT.test(constraint),
						});
					}
				}
			}
		}

		return edges;
	},
	inputs: () => ({ global: ["composer.lock"] }),
});
