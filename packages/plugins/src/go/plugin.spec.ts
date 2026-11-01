import { memoryCtx } from "@tallyrelease/core/testing";
import { describe, expect, it } from "vitest";

import { goPlugin } from "./plugin.js";

import type { Unit } from "@tallyrelease/core";

const unit = (id: string, root: string): Unit => ({
	id,
	root,
	plugin: "go",
	include: [],
	exclude: [],
	version: "tag",
	scheme: "semver",
	tagFormat: "",
	propagate: "auto",
	tags: [],
	initialVersion: null,
	meta: {},
});

describe("go plugin", () => {
	it("discovers modules with their path and tag format", async () => {
		const units = await goPlugin.discover?.(
			memoryCtx({
				repo: "mono",
				files: {
					"go.mod": "module example.com/mono\n\ngo 1.22\n",
					"mod/a/go.mod": '// c\nmodule "example.com/mono/mod/a" // x\n',
					"mod/a/main.go": "package a",
				},
			}),
		);
		expect(units).toEqual([
			{
				id: "mono",
				root: ".",
				version: "tag",
				tagFormat: "v{version}",
				meta: { modulePath: "example.com/mono" },
			},
			{
				id: "a",
				root: "mod/a",
				version: "tag",
				tagFormat: "mod/a/v{version}",
				meta: { modulePath: "example.com/mono/mod/a" },
			},
		]);
	});

	it("creates edges for relative replace directives only", async () => {
		const units = [unit("a", "mod/a"), unit("b", "mod/b"), unit("c", "lib/c")];
		const edges = await goPlugin.edges?.(
			memoryCtx({
				files: {
					"mod/a/go.mod": [
						"module example.com/a",
						"replace example.com/b v1.0.0 => ../b",
						"replace example.com/remote => example.com/fork v1.0.0",
						"replace (",
						'\texample.com/c => "../../lib/c" // local',
						"\texample.com/gone => ../../../outside",
						")",
					].join("\n"),
					"mod/b/go.mod": "module example.com/b\nreplace example.com/b => ./",
				},
			}),
			units,
		);
		expect(edges).toEqual([
			{ from: "b", to: "a", reason: "replace: example.com/b", pinned: false },
			{ from: "c", to: "a", reason: "replace: example.com/c", pinned: false },
		]);
	});
});
