import { coreCodes } from "@tallyrelease/core";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { cliCodes } from "./codes.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

// Line-anchored so string content such as "**/.git/**" is kept.
const comments = /^\s*\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm;
// Quote or bracket context skips identifiers such as CORE_PLUGIN.
const codeLiteral = /["'`[]([EW]_[A-Z0-9_]+)["'`\]]/g;

const sourceCodes = () => {
	const files = globSync("packages/{core,cli}/src/**/*.ts", {
		cwd: root,
	}).filter((f) => !f.endsWith(".spec.ts") && !f.endsWith("/codes.ts"));
	const codes = files.flatMap((f) =>
		[
			...readFileSync(`${root}${f}`, "utf8")
				.replace(comments, "")
				.matchAll(codeLiteral),
		].map((m) => m[1]),
	);

	return [...new Set(codes)].sort();
};

const core = Object.keys(coreCodes.docs);
const cli = Object.keys(cliCodes.docs);

describe("code registries", () => {
	it("register exactly the codes used in the sources", () => {
		expect([...core, ...cli].sort()).toEqual(sourceCodes());
	});

	it("do not share codes", () => {
		expect(core.filter((c) => cli.includes(c))).toEqual([]);
	});
});
