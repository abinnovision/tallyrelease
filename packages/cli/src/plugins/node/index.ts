import { defaultUnitId, definePlugin } from "@tallyrelease/core";
import { parse as parseYaml } from "yaml";

import { dependencyEdges, unitsByPackage } from "../_kit/edges.js";
import { parseJson, readManifest } from "../_kit/manifest.js";
import { globIn, joinRoot, rootOf } from "../_kit/paths.js";
import { BUILD, NUMBERS, PRERELEASE } from "../_kit/semver.js";

import type { Ctx, EdgeDraft, UnitDraft } from "@tallyrelease/core";

interface Manifest {
	name?: string;
	workspaces?: string[] | { packages?: string[] };
	[field: string]: unknown;
}

const PINNED_FIELDS = ["dependencies", "optionalDependencies"] as const;
const UNPINNED_FIELDS = ["peerDependencies", "devDependencies"] as const;
const EXACT = new RegExp(
	`^(workspace:)?(\\*|=?v?${NUMBERS}${PRERELEASE}${BUILD})$`,
);
/** Pinned version ranges rewritten on release; the prefix is kept. */
const PINNED_VERSION = new RegExp(
	`^((?:workspace:)?=?v?)${NUMBERS}${PRERELEASE}${BUILD}$`,
);

const MANIFEST = "package.json";

const manifestPath = (root: string): string => joinRoot(root, MANIFEST);

const readPackage = (ctx: Ctx, root: string): Manifest | undefined =>
	readManifest(ctx, root, MANIFEST);

/** Workspace globs from `pnpm-workspace.yaml` or `package.json`, if any. */
const workspacePatterns = (ctx: Ctx): string[] | undefined => {
	const pnpm = ctx.fs.read("pnpm-workspace.yaml");
	if (pnpm !== undefined) {
		const doc = parseYaml(pnpm) as { packages?: string[] } | null;

		return doc?.packages ?? [];
	}

	const { workspaces } = readPackage(ctx, ".") ?? {};

	if (workspaces === undefined) {
		return undefined;
	}

	return Array.isArray(workspaces) ? workspaces : (workspaces.packages ?? []);
};

const packageRoots = (ctx: Ctx, patterns: string[]): string[] => {
	const manifests = (list: string[]) =>
		ctx.fs.glob(list.map((p) => globIn(p, MANIFEST)));
	const excluded = new Set(
		manifests(patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1))),
	);

	return manifests(patterns.filter((p) => !p.startsWith("!")))
		.filter((p) => !excluded.has(p))
		.map((p) => rootOf(p, MANIFEST));
};

export const nodePlugin = definePlugin({
	apiVersion: 1,
	name: "node",
	discover: (ctx) => {
		const patterns = workspacePatterns(ctx);
		const roots =
			patterns === undefined
				? ctx.fs.exists("package.json")
					? ["."]
					: []
				: packageRoots(ctx, patterns);

		return roots.map((root): UnitDraft => {
			const packageName = readPackage(ctx, root)?.name;

			return {
				id: defaultUnitId(root, ctx.repo.name),
				root,
				version: "file",
				meta: packageName === undefined ? {} : { packageName },
			};
		});
	},
	edges: (ctx, units) => {
		const byName = unitsByPackage(units, "node", (name, prior, unit) => {
			ctx.log.warn(
				`package "${name}" is declared by "${prior.root}" and "${unit.root}"; using "${unit.root}"`,
			);
		});

		const edges: EdgeDraft[] = [];
		for (const to of byName.values()) {
			const manifest = readPackage(ctx, to.root) ?? {};
			const fields = [
				...PINNED_FIELDS.map((field) => [field, EXACT] as const),
				...UNPINNED_FIELDS.map((field) => [field, undefined] as const),
			];
			for (const [field, exact] of fields) {
				const deps = (manifest[field] ?? {}) as Record<string, string>;
				edges.push(...dependencyEdges(byName, to, { field, deps, exact }));
			}
		}

		return edges;
	},
	versionFiles: (_ctx, unit) => [
		{
			path: manifestPath(unit.root),
			read: (content) => {
				const { version } = parseJson(
					manifestPath(unit.root),
					content,
				) as Manifest;

				return typeof version === "string" ? version : undefined;
			},
			write: (content, next, { units, versions }) => {
				const manifest = parseJson(
					manifestPath(unit.root),
					content,
				) as Manifest;
				manifest["version"] = next;
				const released = new Map<string, string>();
				for (const u of units) {
					const name = u.meta["node"]?.["packageName"];
					const version = versions.get(u.id);
					if (typeof name === "string" && version !== undefined) {
						released.set(name, version);
					}
				}

				for (const field of PINNED_FIELDS) {
					const deps = (manifest[field] ?? {}) as Record<string, string>;
					for (const [name, range] of Object.entries(deps)) {
						const version = released.get(name);
						const prefix = PINNED_VERSION.exec(range)?.[1];
						if (version !== undefined && prefix !== undefined) {
							deps[name] = `${prefix}${version}`;
						}
					}
				}

				const indent = /^([ \t]+)"/m.exec(content)?.[1] ?? "  ";
				const text = `${JSON.stringify(manifest, null, indent)}${content.endsWith("\n") ? "\n" : ""}`;

				return content.includes("\r\n") ? text.replaceAll("\n", "\r\n") : text;
			},
		},
	],
	inputs: (ctx) => ({
		global: [
			"yarn.lock",
			"package-lock.json",
			"pnpm-lock.yaml",
			"pnpm-workspace.yaml",
			".yarnrc.yml",
			".yarn/patches/**",
			...(workspacePatterns(ctx) === undefined ? [] : ["package.json"]),
			"tsconfig*.json",
			"turbo.json",
		],
	}),
});
