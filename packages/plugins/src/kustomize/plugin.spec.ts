import { memoryCtx } from "@tallyrelease/core/testing";
import { describe, expect, it } from "vitest";

import { kustomizePlugin } from "./plugin.js";

import type { Unit } from "@tallyrelease/core";

const unit = (
	id: string,
	root: string,
	refs: { path: string; field: string }[] = [],
): Unit => ({
	id,
	root,
	plugin: "kustomize",
	include: [],
	exclude: [],
	version: "none",
	scheme: "semver",
	tagFormat: "",
	propagate: "auto",
	tags: [],
	initialVersion: null,
	meta: { kustomize: { refs } },
});

describe("kustomize plugin", () => {
	it("discovers kustomization files as path ids and respects paths", async () => {
		const files = {
			"k8s/base/a/kustomization.yaml": "",
			"k8s/base/b/kustomization.yml": "",
			"k8s/app/Kustomization": "",
			"other/kustomization.yaml": "",
		};
		const discover = async (paths?: string[]) =>
			(
				await kustomizePlugin.discover?.(
					memoryCtx({ files, options: paths ? { paths } : {} }),
				)
			)?.map((u) => [u.id, u.root]);

		expect(await discover()).toEqual([
			["k8s-app", "k8s/app"],
			["k8s-base-a", "k8s/base/a"],
			["k8s-base-b", "k8s/base/b"],
			["other", "other"],
		]);
		expect(await discover(["k8s/**"])).toHaveLength(3);
	});

	it("includes external files, skips remote refs and warns on missing ones", async () => {
		const ctx = memoryCtx({
			files: {
				"k8s/app/kustomization.yaml": [
					"resources:",
					"  - ../shared/cm.yaml",
					"  - github.com/org/repo//base?ref=v1",
					"  - ../missing",
					"configMapGenerator:",
					"  - name: c",
					"    files: [conf=../shared/c.txt]",
				].join("\n"),
				"k8s/shared/cm.yaml": "",
				"k8s/shared/c.txt": "",
			},
		});
		const [draft] = (await kustomizePlugin.discover?.(ctx)) ?? [];

		expect(draft?.include).toEqual([
			"k8s/app/**",
			"k8s/shared/cm.yaml",
			"k8s/shared/cm.yaml/**",
			"k8s/shared/c.txt",
			"k8s/shared/c.txt/**",
		]);
		expect(draft?.meta).toEqual({ refs: [] });
		expect(ctx.warnings).toEqual([
			'k8s/app: resources "../missing" does not exist',
		]);
	});

	it("creates edges from referenced kustomizations to their users", async () => {
		const base = unit("base", "k8s/base");
		const comp = unit("comp", "k8s/comp", [
			{ path: "../base", field: "resources" },
		]);
		const app = unit("app", "k8s/app", [
			{ path: "../comp", field: "components" },
			{ path: "../base", field: "resources" },
			{ path: "../gone", field: "resources" },
		]);

		expect(
			await kustomizePlugin.edges?.(memoryCtx(), [base, comp, app]),
		).toEqual([
			{
				from: "base",
				to: "comp",
				reason: "resources: ../base",
				pinned: false,
			},
			{
				from: "comp",
				to: "app",
				reason: "components: ../comp",
				pinned: false,
			},
			{
				from: "base",
				to: "app",
				reason: "resources: ../base",
				pinned: false,
			},
		]);
	});
});
