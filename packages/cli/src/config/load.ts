import { coreCodes } from "@tallyrelease/core";
import { parse } from "yaml";

import { cliCodes } from "../codes.js";
import { configSchema } from "./schema.js";

import type { ReadonlyFs, TallyConfig } from "@tallyrelease/core";

/** Reads and validates the config file at the repo-relative `path`. */
export const loadConfig = (fs: ReadonlyFs, path: string): TallyConfig => {
	const text = fs.read(path);
	if (text === undefined) {
		throw cliCodes.error(
			"E_CONFIG_MISSING",
			`config file "${path}" not found; create it, for example: plugins: { node: {} }`,
			{ path },
		);
	}

	let raw: unknown;
	try {
		raw = parse(text) ?? {};
	} catch (error) {
		throw coreCodes.error(
			"E_CONFIG",
			`${path}: ${error instanceof Error ? error.message : String(error)}`,
			{ path },
		);
	}

	const result = configSchema.safeParse(raw);
	if (!result.success) {
		const issues = result.error.issues.map(
			(i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
		);
		throw coreCodes.error("E_CONFIG", `${path}: ${issues.join("; ")}`, {
			path,
			issues: result.error.issues,
		});
	}

	return result.data;
};
