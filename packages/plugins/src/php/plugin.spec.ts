import { memoryCtx } from "@tallyrelease/core/testing";
import { describe, expect, it } from "vitest";

import { phpPlugin } from "./plugin.js";

import type { Unit } from "@tallyrelease/core";

const json = (o: Record<string, unknown>) => JSON.stringify(o);

const unit = (id: string, root: string, packageName: string): Unit => ({
	id,
	root,
	plugin: "php",
	include: [],
	exclude: [],
	version: "tag",
	scheme: "semver",
	tagFormat: "",
	propagate: "auto",
	tags: [],
	initialVersion: null,
	meta: { php: { packageName } },
});

describe("php plugin", () => {
	it("discovers a single repo as unit '.' with the repo name", async () => {
		const units = await phpPlugin.discover?.(
			memoryCtx({
				repo: "app",
				files: { "composer.json": json({ name: "v/app" }) },
			}),
		);
		expect(units).toEqual([
			{ id: "app", root: ".", version: "tag", meta: { packageName: "v/app" } },
		]);
	});

	it("discovers path repositories", async () => {
		const units = await phpPlugin.discover?.(
			memoryCtx({
				repo: "mono",
				files: {
					"composer.json": json({
						name: "v/mono",
						repositories: [{ type: "path", url: "./libs/*" }],
					}),
					"libs/x/composer.json": json({ name: "v/x" }),
				},
			}),
		);
		expect(units?.map((u) => [u.id, u.root])).toEqual([
			["mono", "."],
			["x", "libs/x"],
		]);
	});

	it("creates require edges, pinned only for exact require constraints", async () => {
		const units = [unit("mono", ".", "v/mono"), unit("x", "libs/x", "v/x")];
		const edges = async (composer: Record<string, unknown>) =>
			await phpPlugin.edges?.(
				memoryCtx({ files: { "composer.json": json(composer) } }),
				units,
			);

		expect(
			await edges({ name: "v/mono", require: { "v/x": "1.2.3" } }),
		).toEqual([
			{ from: "x", to: "mono", reason: "require: v/x", pinned: true },
		]);
		for (const constraint of ["self.version", "1.2.3.4", "=v1.2.3"]) {
			// eslint-disable-next-line no-await-in-loop -- sequential cases
			const pinned = await edges({
				name: "v/mono",
				require: { "v/x": constraint },
			});
			expect(pinned).toEqual([
				{ from: "x", to: "mono", reason: "require: v/x", pinned: true },
			]);
		}

		expect(await edges({ name: "v/mono", require: { "v/x": "^1.2" } })).toEqual(
			[{ from: "x", to: "mono", reason: "require: v/x", pinned: false }],
		);
		expect(
			await edges({ name: "v/mono", "require-dev": { "v/x": "1.2.3" } }),
		).toEqual([
			{ from: "x", to: "mono", reason: "require-dev: v/x", pinned: false },
		]);
	});

	it("declares composer.lock as input and no version files", async () => {
		expect(await phpPlugin.inputs?.(memoryCtx())).toEqual({
			global: ["composer.lock"],
		});
		expect(phpPlugin.versionFiles).toBeUndefined();
	});
});
