import { defaultUnitId, definePlugin } from "@tallyrelease/core";

import { dependencyEdges, unitsByPackage } from "../_kit/edges.js";
import { readManifest } from "../_kit/manifest.js";
import { globIn, rootOf } from "../_kit/paths.js";
import { NUMBERS, PRERELEASE } from "../_kit/semver.js";

import type { Ctx, EdgeDraft, UnitDraft } from "@tallyrelease/core";

interface Composer {
	name?: string;
	repositories?: unknown;
	[field: string]: unknown;
}

const EXACT = new RegExp(
	`^(self\\.version|=?v?${NUMBERS}(\\.\\d+)?${PRERELEASE})$`,
);

const COMPOSER = "composer.json";

const readComposer = (ctx: Ctx, root: string): Composer | undefined =>
	readManifest(ctx, root, COMPOSER);

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
				.glob(pathRepoGlobs(rootComposer).map((u) => globIn(u, COMPOSER)))
				.map((p) => rootOf(p, COMPOSER))
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
		const byName = unitsByPackage(units, "php");

		const edges: EdgeDraft[] = [];
		for (const to of byName.values()) {
			const composer = readComposer(ctx, to.root) ?? {};
			for (const field of ["require", "require-dev"] as const) {
				const deps = (composer[field] ?? {}) as Record<string, string>;
				edges.push(
					...dependencyEdges(byName, to, {
						field,
						deps,
						exact: field === "require" ? EXACT : undefined,
					}),
				);
			}
		}

		return edges;
	},
	inputs: () => ({ global: ["composer.lock"] }),
});
