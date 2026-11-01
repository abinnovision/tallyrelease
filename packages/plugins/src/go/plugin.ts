import { defaultUnitId, definePlugin } from "@tallyrelease/core";

import { edgeBetween } from "../_kit/edges.js";
import { joinRoot, rootOf } from "../_kit/paths.js";

import type { Ctx, EdgeDraft, UnitDraft } from "@tallyrelease/core";

const GO_MOD = "go.mod";
const MODULE = /^module\s+"?([^\s"]+)"?/;
const LOCAL = /^\.{1,2}(\/|$)/;

const readGoMod = (ctx: Ctx, root: string): string | undefined =>
	ctx.fs.read(joinRoot(root, GO_MOD));

/** `go.mod` lines without comments and blank lines. */
const lines = (source: string): string[] =>
	source
		.split("\n")
		.map((line) => line.replace(/\/\/.*$/, "").trim())
		.filter((line) => line !== "");

const modulePath = (source: string): string | undefined => {
	for (const line of lines(source)) {
		const match = MODULE.exec(line);
		if (match) {
			return match[1];
		}
	}

	return undefined;
};

/** Relative targets of `replace` directives, single-line and block form. */
const replaceTargets = (source: string): { module: string; path: string }[] => {
	const targets: { module: string; path: string }[] = [];
	let block = false;
	for (const line of lines(source)) {
		let spec: string | undefined;
		if (block) {
			if (line === ")") {
				block = false;
			} else {
				spec = line;
			}
		} else if (/^replace\s*\(/.test(line)) {
			block = true;
		} else if (line.startsWith("replace ")) {
			spec = line.slice("replace ".length);
		}

		const [from, to] = spec?.split("=>") ?? [];
		const module = from?.trim().split(/\s+/)[0]?.replaceAll('"', "");
		const path = to?.trim().split(/\s+/)[0]?.replaceAll('"', "");
		if (module && path && LOCAL.test(path)) {
			targets.push({ module, path });
		}
	}

	return targets;
};

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

export const goPlugin = definePlugin({
	apiVersion: 1,
	name: "go",
	discover: (ctx) => {
		const roots = new Set(
			ctx.fs
				.glob([GO_MOD, `**/${GO_MOD}`])
				.map((p) => (p === GO_MOD ? "." : rootOf(p, GO_MOD))),
		);

		return [...roots].map((root): UnitDraft => {
			const module = modulePath(readGoMod(ctx, root) ?? "");

			return {
				id: defaultUnitId(root, ctx.repo.name),
				root,
				version: "tag",
				tagFormat: root === "." ? "v{version}" : `${root}/v{version}`,
				meta: module === undefined ? {} : { modulePath: module },
			};
		});
	},
	edges: (ctx, units) => {
		const owned = units.filter((u) => u.plugin === "go");
		const byRoot = new Map(owned.map((u) => [u.root, u]));

		const edges: EdgeDraft[] = [];
		for (const to of owned) {
			for (const { module, path } of replaceTargets(
				readGoMod(ctx, to.root) ?? "",
			)) {
				const target = resolve(to.root, path);
				edges.push(
					...edgeBetween(
						target === undefined ? undefined : byRoot.get(target),
						to,
						{
							reason: `replace: ${module}`,
							pinned: false,
						},
					),
				);
			}
		}

		return edges;
	},
});
