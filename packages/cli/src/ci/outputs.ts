import type { OutputEntry } from "./provider.js";
import type { ReleaseEntry } from "../plan-schema.js";
import type { AffectedDoc } from "@tallyrelease/core";

/** Outputs of `affected`; units are ordered by id. */
export const affectedOutputs = (doc: AffectedDoc): OutputEntry[] => [
	{
		key: "affected",
		value: JSON.stringify(
			doc.units.map(({ id, path, plugin, reason, released, tags }) => ({
				id,
				path,
				plugin,
				reason,
				released,
				tags,
			})),
		),
	},
	{
		key: "affected-paths",
		value: doc.units.map((u) => u.path).join("\n"),
		multiline: true,
	},
	{ key: "all", value: String(doc.build.all) },
	{ key: "base", value: doc.build.base ?? "" },
	{ key: "base-source", value: doc.build.baseSource },
];

/** Output of `plan`: the path of the written plan document. */
export const planOutputs = (path: string): OutputEntry[] => [
	{ key: "plan", value: path },
];

/** Output of `run`: the compact JSON list of releases. */
export const releasesOutputs = (
	releases: readonly ReleaseEntry[],
): OutputEntry[] => [{ key: "releases", value: JSON.stringify(releases) }];
