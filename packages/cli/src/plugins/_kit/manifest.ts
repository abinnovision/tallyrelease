import { joinRoot } from "./paths.js";

import type { Ctx } from "@tallyrelease/core";

/** Parses a JSON manifest; a syntax error names the file. */
export const parseJson = (path: string, raw: string): unknown => {
	try {
		return JSON.parse(raw);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`invalid JSON in ${path}: ${reason}`, { cause: error });
	}
};

/** Reads and parses `file` inside unit `root`; undefined when it is missing. */
export const readManifest = (
	ctx: Pick<Ctx, "fs">,
	root: string,
	file: string,
): Record<string, unknown> | undefined => {
	const path = joinRoot(root, file);
	const raw = ctx.fs.read(path);

	return raw === undefined
		? undefined
		: (parseJson(path, raw) as Record<string, unknown>);
};
