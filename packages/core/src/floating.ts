import { coreCodes } from "./codes.js";
import { compileTagFormat } from "./tags.js";

import type { Unit, VersionScheme } from "./plugin.js";

const TOKEN = /\{([^{}]*)\}/gu;
const TOKENS = new Set(["id", "major", "minor"]);

/** Throws `E_CONFIG` for a floating tag format with an unknown token. */
export const validateFloating = (formats: readonly string[]): void => {
	for (const format of formats) {
		const unknown = [...format.matchAll(TOKEN)].find(
			([, token]) => !TOKENS.has(token ?? ""),
		);
		if (unknown) {
			throw coreCodes.error(
				"E_CONFIG",
				`floating tag format "${format}" uses unknown token "${unknown[0]}"; use {id}, {major} or {minor}`,
				{ format },
			);
		}
	}
};

/**
 * Floating tags `version` takes: per format, the rendered name when `version`
 * is stable and not lower than any stable version among the unit's `tags`
 * (tag names, others ignored) that renders to the same name. In format order,
 * without duplicates.
 */
export const renderFloatingTags = <V>(
	unit: Pick<Unit, "id" | "tagFormat">,
	version: string,
	{
		tags,
		scheme,
		formats,
	}: {
		tags: readonly string[];
		scheme: VersionScheme<V>;
		formats: readonly string[];
	},
): string[] => {
	const released = scheme.parse(version);
	if (released === undefined || scheme.isPrerelease(released)) {
		return [];
	}

	const format = compileTagFormat(unit.tagFormat, unit.id);
	const versions = tags.flatMap((tag) => {
		const raw = format.match(tag);
		const v = raw === undefined ? undefined : scheme.parse(raw);

		return v === undefined || scheme.isPrerelease(v) ? [] : [v];
	});
	const render = (pattern: string, v: V) => {
		const { major, minor } = scheme.core(v);

		return pattern
			.replaceAll("{id}", unit.id)
			.replaceAll("{major}", String(major))
			.replaceAll("{minor}", String(minor));
	};

	const names = formats.flatMap((pattern) => {
		const name = render(pattern, released);
		const highest = versions.every(
			(v) => render(pattern, v) !== name || scheme.compare(v, released) <= 0,
		);

		return highest ? [name] : [];
	});

	return [...new Set(names)];
};
