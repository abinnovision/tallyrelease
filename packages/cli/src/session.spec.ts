import { memoryFs } from "@tallyrelease/core/testing";
import { describe, expect, it } from "vitest";

import { createSession, webUrl } from "./session.js";

describe("webUrl", () => {
	it.each([
		["https://github.com/o/r.git", "https://github.com/o/r"],
		["https://u:p@ss@host/o/r.git", "https://host/o/r"],
		["https://x-access-token:ghs_abc@github.com/o/r", "https://github.com/o/r"],
		["ssh://git@host:2222/o/r.git/", "https://host/o/r"],
		["git@github.com:o/r.git", "https://github.com/o/r"],
		["/srv/git/r.git", null],
		["file:///srv/git/r.git", null],
	])("maps %s", (remote, url) => {
		expect(webUrl(remote)).toBe(url);
	});
});

describe("createSession", () => {
	it("loads the working tree workspace once and workspaces at a ref fresh", async () => {
		const files = memoryFs({ "tallyrelease.yaml": "plugins: {}\n" });
		let reads = 0;
		const session = createSession(
			{
				env: {},
				cwd: "/repo",
				stdout: { write: () => true },
				stderr: { write: () => true },
				fs: {
					...files,
					read: (path) => {
						reads += path === "tallyrelease.yaml" ? 1 : 0;

						return files.read(path);
					},
				},
				fsAt: () => files,
			},
			{ config: "tallyrelease.yaml" },
		);

		const first = await session.workspace();
		const second = await session.workspaceAt(null, (workspace) =>
			Promise.resolve(workspace),
		);

		expect(second).toBe(first);
		expect(reads).toBe(1);

		const atRef = async () =>
			await session.workspaceAt("c0", (workspace) =>
				Promise.resolve(workspace),
			);
		expect(await atRef()).not.toBe(await atRef());
		expect(reads).toBe(3);
	});

	it("never loads local plugins of privileged commands on pull request events", async () => {
		const imported: string[] = [];
		const session = createSession(
			{
				env: { GITHUB_EVENT_NAME: "pull_request_target" },
				cwd: "/repo",
				stdout: { write: () => true },
				stderr: { write: () => true },
				fs: memoryFs({
					"tallyrelease.yaml": "plugins:\n  local: { path: plugin.ts }\n",
				}),
				importPlugin: (specifier) => {
					imported.push(specifier);

					return Promise.resolve({ apiVersion: 1, name: "local" });
				},
			},
			{
				config: "tallyrelease.yaml",
				privileged: true,
				allowLocalPlugins: true,
			},
		);

		await expect(session.workspace()).rejects.toMatchObject({
			code: "E_PLUGIN_LOCAL",
			message:
				'plugin "local": privileged commands never load local plugins on a pull request head',
		});
		expect(imported).toEqual([]);
	});
});
