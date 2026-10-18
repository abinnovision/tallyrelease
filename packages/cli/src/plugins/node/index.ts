import { defaultUnitId, definePlugin } from "@tallyrelease/core";
import { parse as parseYaml } from "yaml";

import { parseJson } from "../json.js";

import type { Ctx, EdgeDraft, Unit, UnitDraft } from "@tallyrelease/core";

interface Manifest {
	name?: string;
	workspaces?: string[] | { packages?: string[] };
	[field: string]: unknown;
}

const PINNED_FIELDS = ["dependencies", "optionalDependencies"] as const;
const UNPINNED_FIELDS = ["peerDependencies", "devDependencies"] as const;
const EXACT =
	/^(workspace:)?(\*|=?v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?)$/;
/** Pinned version ranges rewritten on release; the prefix is kept. */
const PINNED_VERSION =
	/^((?:workspace:)?=?v?)\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

const manifestPath = (root: string): string =>
	root === "." ? "package.json" : `${root}/package.json`;

const readManifest = (ctx: Ctx, root: string): Manifest | undefined => {
	const path = manifestPath(root);
	const raw = ctx.fs.read(path);

	return raw === undefined ? undefined : (parseJson(path, raw) as Manifest);
};

/** Workspace globs from `pnpm-workspace.yaml` or `package.json`, if any. */
const workspacePatterns = (ctx: Ctx): string[] | undefined => {
	const pnpm = ctx.fs.read("pnpm-workspace.yaml");
	if (pnpm !== undefined) {
		const doc = parseYaml(pnpm) as { packages?: string[] } | null;

		return doc?.packages ?? [];
	}

	const { workspaces } = readManifest(ctx, ".") ?? {};

	if (workspaces === undefined) {
		return undefined;
	}

	return Array.isArray(workspaces) ? workspaces : (workspaces.packages ?? []);
};

const packageRoots = (ctx: Ctx, patterns: string[]): string[] => {
	const manifests = (list: string[]) =>
		ctx.fs.glob(list.map((p) => `${p.replace(/\/+$/, "")}/package.json`));
	const excluded = new Set(
		manifests(patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1))),
	);

	return manifests(patterns.filter((p) => !p.startsWith("!")))
		.filter((p) => !excluded.has(p))
		.map((p) => p.slice(0, -"/package.json".length));
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
			const packageName = readManifest(ctx, root)?.name;

			return {
				id: defaultUnitId(root, ctx.repo.name),
				root,
				version: "file",
				meta: packageName === undefined ? {} : { packageName },
			};
		});
	},
	edges: (ctx, units) => {
		const byName = new Map<string, Unit>();
		for (const unit of units) {
			const name = unit.meta["node"]?.["packageName"];
			if (unit.plugin === "node" && typeof name === "string") {
				const prior = byName.get(name);
				if (prior) {
					ctx.log.warn(
						`package "${name}" is declared by "${prior.root}" and "${unit.root}"; using "${unit.root}"`,
					);
				}

				byName.set(name, unit);
			}
		}

		const edges: EdgeDraft[] = [];
		for (const to of byName.values()) {
			const manifest = readManifest(ctx, to.root) ?? {};
			const fields = [
				...PINNED_FIELDS.map((field) => [field, true] as const),
				...UNPINNED_FIELDS.map((field) => [field, false] as const),
			];
			for (const [field, pinnable] of fields) {
				const deps = (manifest[field] ?? {}) as Record<string, string>;
				for (const [name, range] of Object.entries(deps)) {
					const from = byName.get(name);
					if (from && from.id !== to.id) {
						edges.push({
							from: from.id,
							to: to.id,
							reason: `${field}: ${name}`,
							pinned: pinnable && EXACT.test(range),
						});
					}
				}
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
