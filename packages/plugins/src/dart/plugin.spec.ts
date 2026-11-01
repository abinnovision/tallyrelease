import { memoryCtx } from "@tallyrelease/core/testing";
import { describe, expect, it } from "vitest";

import { dartPlugin } from "./plugin.js";

import type { Unit } from "@tallyrelease/core";

const unit = (id: string, root: string, packageName: string): Unit => ({
	id,
	root,
	plugin: "dart",
	include: [],
	exclude: [],
	version: "file",
	scheme: "semver",
	tagFormat: "",
	propagate: "auto",
	tags: [],
	initialVersion: null,
	meta: { dart: { packageName } },
});

const APP = `name: app
publish_to: none
version: 1.2.0+5
dependencies:
  core:
    path: ../../packages/core
dev_dependencies:
  lints: ^4.0.0
`;

const files = {
	"apps/app/pubspec.yaml": APP,
	"packages/core/pubspec.yaml": "name: core\nversion: 0.3.0\n",
	"packages/core/example/pubspec.yaml": "name: core_example\n",
	"packages/core/.dart_tool/pubspec.yaml": "name: tool\n",
	"packages/core/build/pubspec.yaml": "name: built\n",
};

describe("dart discovery", () => {
	it("discovers each pubspec.yaml outside dot, build and example directories", async () => {
		const units = await dartPlugin.discover?.(memoryCtx({ files }));
		expect(units).toEqual([
			{
				id: "app",
				root: "apps/app",
				version: "file",
				meta: { packageName: "app" },
			},
			{
				id: "core",
				root: "packages/core",
				version: "file",
				meta: { packageName: "core" },
			},
		]);
	});

	it("treats a root pubspec.yaml as unit '.' with the repo name", async () => {
		const ctx = memoryCtx({
			files: { "pubspec.yaml": "name: solo\n" },
			repo: "mono",
		});
		expect(await dartPlugin.discover?.(ctx)).toEqual([
			{
				id: "mono",
				root: ".",
				version: "file",
				meta: { packageName: "solo" },
			},
		]);
	});

	it.each([
		["an unversioned workspace root", "name: _ws\nworkspace: [pkg]\n", {}],
		["a melos root", "name: _ws\n", { "melos.yaml": "name: ws\n" }],
	])("skips %s", async (_, root, extra) => {
		const units = await dartPlugin.discover?.(
			memoryCtx({
				files: {
					"pubspec.yaml": root,
					"pkg/pubspec.yaml": "name: pkg\n",
					...extra,
				},
			}),
		);
		expect(units?.map((u) => u.root)).toEqual(["pkg"]);
	});

	it.each([
		[
			"a versioned workspace root",
			"name: ws\nversion: 1.0.0\nworkspace: [pkg]\n",
		],
		["a plain root pubspec", "name: ws\n"],
	])("keeps %s as unit '.'", async (_, root) => {
		const units = await dartPlugin.discover?.(
			memoryCtx({
				files: { "pubspec.yaml": root, "pkg/pubspec.yaml": "name: pkg\n" },
			}),
		);
		expect(units?.map((u) => u.root).sort()).toEqual([".", "pkg"]);
	});

	it("rejects buildOffset", async () => {
		const result = await dartPlugin.options?.["~standard"].validate({
			buildOffset: 1,
		});
		expect(result?.issues).toBeDefined();
	});
});

describe("dart edges", () => {
	const units = [
		unit("app", "apps/app", "app"),
		unit("core", "packages/core", "core"),
	];
	const edgesOf = (field: string, spec: string) =>
		dartPlugin.edges?.(
			memoryCtx({
				files: {
					"apps/app/pubspec.yaml": `name: app\n${field}:\n  core: ${spec}\n`,
				},
			}),
			units,
		);
	const edge = (field: string, pinned: boolean) => [
		{ from: "core", to: "app", reason: `${field}: core`, pinned },
	];

	it("pins a path dependency in dependencies", async () => {
		expect(await dartPlugin.edges?.(memoryCtx({ files }), units)).toEqual(
			edge("dependencies", true),
		);
	});

	it.each([
		["dependencies", "{ path: ../../packages/core }", true],
		["dev_dependencies", "{ path: ../../packages/core }", false],
		["dependency_overrides", "{ path: ../../packages/core }", false],
		["dependencies", "1.2.0", true],
		["dependencies", "1.2.0-rc.1+3", true],
		["dependencies", "^1.0.0", false],
		["dependencies", "any", false],
		["dependencies", '">=1.0.0 <2.0.0"', false],
		["dependencies", "", false],
		["dev_dependencies", "1.2.0", false],
		["dependency_overrides", "1.2.0", false],
	])("%s %s pinned: %s", async (field, spec, pinned) => {
		expect(await edgesOf(field, spec)).toEqual(edge(field, pinned));
	});

	it.each([
		["a git map", "{ git: https://example.com/core.git }"],
		["a hosted map", "{ hosted: https://pub.example.com }"],
		["a numeric scalar", "1.0"],
	])("adds no edge for %s", async (_, spec) => {
		expect(await edgesOf("dependencies", spec)).toEqual([]);
	});
});

describe("dart inputs", () => {
	const inputs = (files: Record<string, string>) =>
		dartPlugin.inputs?.(memoryCtx({ files }));
	const base = ["pubspec.lock", "melos.yaml", "analysis_options.yaml"];

	it("lists the lock, melos and analysis files", async () => {
		expect(await inputs({ "pubspec.yaml": "name: a\n" })).toEqual({
			global: base,
		});
	});

	it("adds a skipped workspace root", async () => {
		expect(
			await inputs({ "pubspec.yaml": "name: ws\nworkspace: [a]\n" }),
		).toEqual({ global: [...base, "pubspec.yaml"] });
	});
});

describe("dart version file", () => {
	const app = unit("app", "apps/app", "app");
	const versionFile = async () => {
		const [file] = (await dartPlugin.versionFiles?.(memoryCtx(), app)) ?? [];
		if (!file) {
			throw new Error("no version file");
		}

		return file;
	};

	const ctx = { unit: app, units: [], versions: new Map<string, string>() };

	it("reads and writes the version line", async () => {
		const file = await versionFile();
		expect(file.path).toBe("apps/app/pubspec.yaml");
		expect(file.read(APP)).toBe("1.2.0+5");
		expect(file.write(APP, "1.2.1+102", ctx)).toBe(
			APP.replace("1.2.0+5", "1.2.1+102"),
		);
	});

	it("adds a missing version line after the name", async () => {
		const file = await versionFile();
		expect(file.read("name: a\n")).toBeUndefined();
		expect(file.write("name: a\nenvironment: {}\n", "1.0.0", ctx)).toBe(
			"name: a\nversion: 1.0.0\nenvironment: {}\n",
		);
	});

	it("reads and writes a CRLF pubspec", async () => {
		const file = await versionFile();
		const crlf = "name: a\r\nversion: 1.0.0\r\nenvironment: {}\r\n";
		expect(file.read(crlf)).toBe("1.0.0");
		expect(file.write(crlf, "1.0.1", ctx)).toBe(
			"name: a\r\nversion: 1.0.1\r\nenvironment: {}\r\n",
		);
	});

	it("adds a missing version line with CRLF and keeps the trailing newline", async () => {
		const file = await versionFile();
		expect(file.write("name: a\r\nenvironment: {}\r\n", "1.0.0", ctx)).toBe(
			"name: a\r\nversion: 1.0.0\r\nenvironment: {}\r\n",
		);
		expect(file.write("name: a\n", "1.0.0", ctx)).toBe(
			"name: a\nversion: 1.0.0\n",
		);
	});

	it("drops the build number and keeps quotes", async () => {
		const file = await versionFile();
		expect(file.write("name: a\nversion: 1.2.0+5\n", "1.2.1", ctx)).toBe(
			"name: a\nversion: 1.2.1\n",
		);
		expect(file.write('name: a\nversion: "1.2.0+5"\n', "1.2.1", ctx)).toBe(
			'name: a\nversion: "1.2.1"\n',
		);
	});

	describe("exact pins", () => {
		const released = {
			units: [unit("core", "packages/core", "core"), app],
			versions: new Map([
				["core", "0.4.0"],
				["app", "1.2.1"],
			]),
		};
		const pubspec = (eol: string) =>
			[
				"name: app",
				"version: 1.2.0",
				"dependencies:",
				"  core: 0.3.0",
				"  quoted: '0.3.0' # keep",
				"  ranged: ^0.3.0",
				"  nested:",
				"    version: 0.3.0",
				"dev_dependencies:",
				"  core: 0.3.0",
				"",
			].join(eol);

		it("rewrites exact pins of released units and keeps quotes", async () => {
			const file = await versionFile();
			const units = [
				...released.units,
				unit("quoted", "packages/quoted", "quoted"),
			];
			const versions = new Map([...released.versions, ["quoted", "0.4.0"]]);
			expect(
				file.write(pubspec("\n"), "1.2.1", { unit: app, units, versions }),
			).toBe(
				[
					"name: app",
					"version: 1.2.1",
					"dependencies:",
					"  core: 0.4.0",
					"  quoted: '0.4.0' # keep",
					"  ranged: ^0.3.0",
					"  nested:",
					"    version: 0.3.0",
					"dev_dependencies:",
					"  core: 0.3.0",
					"",
				].join("\n"),
			);
		});

		it("keeps CRLF", async () => {
			const file = await versionFile();
			const out = file.write(pubspec("\r\n"), "1.2.1", {
				unit: app,
				...released,
			});
			expect(out).toContain("  core: 0.4.0\r\n");
			expect(out.replaceAll("\r\n", "")).not.toContain("\n");
		});

		it("leaves pins of unreleased units", async () => {
			const file = await versionFile();
			const out = file.write(pubspec("\n"), "1.2.1", {
				unit: app,
				units: [app],
				versions: new Map([["app", "1.2.1"]]),
			});
			expect(out).toContain("  core: 0.3.0\n  quoted");
		});
	});

	it("keeps quotes and comments", async () => {
		const file = await versionFile();
		const quoted = "name: a\nversion: '1.0.0' # app\n";
		expect(file.read(quoted)).toBe("1.0.0");
		expect(file.write(quoted, "1.1.0", ctx)).toBe(
			"name: a\nversion: '1.1.0' # app\n",
		);
	});
});
