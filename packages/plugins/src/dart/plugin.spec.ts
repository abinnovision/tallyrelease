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

	it("rejects buildOffset", async () => {
		const result = await dartPlugin.options?.["~standard"].validate({
			buildOffset: 1,
		});
		expect(result?.issues).toBeDefined();
	});
});

describe("dart edges", () => {
	it("adds an unpinned edge per path dependency on a unit", async () => {
		const units = [
			unit("app", "apps/app", "app"),
			unit("core", "packages/core", "core"),
		];
		expect(await dartPlugin.edges?.(memoryCtx({ files }), units)).toEqual([
			{
				from: "core",
				to: "app",
				reason: "dependencies: core",
				pinned: false,
			},
		]);
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

	it("keeps quotes and comments", async () => {
		const file = await versionFile();
		const quoted = "name: a\nversion: '1.0.0' # app\n";
		expect(file.read(quoted)).toBe("1.0.0");
		expect(file.write(quoted, "1.1.0", ctx)).toBe(
			"name: a\nversion: '1.1.0' # app\n",
		);
	});
});
