import { z } from "zod";

import type { Equals, Keys } from "../types.js";
import type { GroupConfig, TallyConfig } from "@tallyrelease/core";

const globs = z.array(z.string()).exactOptional();
const propagate = z.enum(["auto", "patch", "rebuild"]).meta({
	description:
		"Policy for this unit when a dependency is released: patch (at least a patch bump), rebuild (rebuild only) or auto (patch if the edge is pinned, else rebuild).",
});

const tagFormat = z.string().meta({
	description:
		"Tag template. Defaults to {id}-v{version}, or v{version} for the root unit.",
});

const initialVersion = z.string().meta({
	description:
		"Version of the first release, parsed by the unit's scheme. Defaults to the scheme's initial version (semver: 1.0.0).",
});

const bumpLevel = z.enum(["major", "minor", "patch"]);

const releasePr = z.enum(["shared", "separate"]).meta({
	description:
		"Release PR of the release item: shared (one PR for all shared items) or separate (its own PR).",
});

const unitId = z.string().regex(/^(?!\.\.?$)[A-Za-z0-9._-]+$/);
const groupUnits = z.array(unitId).meta({ description: "Member unit ids." });
const groupTags = z
	.array(z.string())
	.meta({ description: "Selects released units with any of these tags." });

const groupUnion = z.union([
	z.strictObject({
		units: groupUnits,
		tags: groupTags.exactOptional(),
		releasePr: releasePr.exactOptional(),
	}),
	z.strictObject({
		units: groupUnits.exactOptional(),
		tags: groupTags,
		releasePr: releasePr.exactOptional(),
	}),
]);

const groupSchema: z.ZodType<GroupConfig> = groupUnion;

const globRejected = ["id", "include", "exclude", "versionFiles"] as const;

const unitOverlay = z.strictObject({
	id: z
		.string()
		.meta({
			description:
				"Unit id (letters, digits, dot, underscore, dash). Defaults to the discovered id, or the repo name for the root unit.",
		})
		.exactOptional(),
	include: globs.meta({
		description:
			"Globs of files owned by the unit. Replaces the default (the unit root).",
	}),
	exclude: globs.meta({
		description:
			"Globs excluded from the unit, appended to the default (roots of nested units).",
	}),
	release: z
		.boolean()
		.meta({
			description:
				"Whether the unit is versioned and tagged. Default false (build-only).",
		})
		.exactOptional(),
	version: z
		.enum(["file", "tag"], {
			error: (issue) =>
				issue.input === "none"
					? 'version "none" is not supported, use release: false'
					: undefined,
		})
		.meta({
			description:
				"Where a released unit's version lives. file: version file written by the plugin. tag: git tags only. Defaults to the plugin's version source.",
		})
		.exactOptional(),
	scheme: z
		.string()
		.meta({ description: "Versioning scheme. Defaults to semver." })
		.exactOptional(),
	tagFormat: tagFormat.exactOptional(),
	propagate: propagate.exactOptional(),
	tags: z
		.array(z.string().regex(/^[A-Za-z0-9._-]+$/))
		.meta({
			description:
				"Labels for filtering with affected --tag (letters, digits, dot, underscore, dash), for example docker or npm.",
		})
		.exactOptional(),
	initialVersion: initialVersion.exactOptional(),
	releasePr: releasePr
		.meta({
			description:
				"Release PR of this ungrouped unit; set it on the group for grouped units. Defaults to defaults.releasePr.",
		})
		.exactOptional(),
	versionFiles: z
		.array(
			z.strictObject({
				file: z
					.string()
					.meta({ description: "File relative to the repository root." }),
				pattern: z
					.string()
					.meta({
						description:
							"Text holding the version, with {id}, {version}, {major}, {minor} and {patch}; needs a version token and literal text. Without pattern, the file uses version markers.",
					})
					.exactOptional(),
			}),
		)
		.meta({
			description:
				"Text files updated on release: matches of pattern rendering a version from the previous release up to the next are replaced with the next version. Without pattern, the first version on each line marked `# x-tallyrelease-version` or `<!-- x-tallyrelease-version -->` is replaced with the next version, also on a first release.",
		})
		.exactOptional(),
});

// `path` and `package` are owned by the cli, which strips them before core sees the entry.
const pluginEntry = z
	.looseObject({
		path: z
			.string()
			.min(1)
			.meta({
				description:
					"Local plugin: a .ts or .js file relative to the repository root that exports a plugin of this name.",
			})
			.exactOptional(),
		package: z
			.string()
			.regex(/^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/, {
				error: "package must be an npm package name",
			})
			.meta({
				description:
					"Plugin package resolved from the repository root's node_modules that exports a plugin of this name. Excludes path.",
			})
			.exactOptional(),
	})
	.refine((entry) => entry.path === undefined || entry.package === undefined, {
		error: "set path or package, not both",
	});

const configObject = z.strictObject({
	$schema: z
		.string()
		.meta({ description: "Schema reference for editors, ignored." })
		.exactOptional(),
	plugins: z
		.record(z.string(), pluginEntry.nullable())
		.meta({
			description:
				"Enabled plugins and their options, run in the listed order. Only listed plugins run.",
		})
		.default({}),
	defaults: z
		.strictObject({
			release: z
				.boolean()
				.meta({
					description:
						"Release all units unless a unit sets release: false. Default false.",
				})
				.exactOptional(),
			tagFormat: tagFormat.exactOptional(),
			propagate: propagate.exactOptional(),
			initialVersion: initialVersion.exactOptional(),
			releasePr: releasePr
				.meta({
					description:
						"Release PR of every release item: shared (default) or separate.",
				})
				.exactOptional(),
		})
		.meta({ description: "Defaults applied to every unit." })
		.exactOptional(),
	units: z
		.record(z.string(), unitOverlay)
		.superRefine((units, ctx) => {
			for (const [key, overlay] of Object.entries(units)) {
				const field = key.includes("*")
					? globRejected.find((f) => overlay[f] !== undefined)
					: undefined;
				if (field !== undefined) {
					ctx.addIssue({
						code: "custom",
						path: [key, field],
						message: `unit overlay "${key}" cannot set "${field}" on a glob key`,
					});
				}
			}
		})
		.meta({
			description:
				"Unit overlays keyed by root path or glob. A root without a discovered unit becomes a config-only unit. In a glob key, * matches one path segment and skips dot directories; globs never create units, cannot set id, include, exclude or versionFiles, and exact keys win over them per field.",
		})
		.exactOptional(),
	deps: z
		.array(
			z.strictObject({
				from: z.string().meta({ description: "Id of the dependency." }),
				to: z.string().meta({ description: "Id of the dependent unit." }),
				pinned: z
					.boolean()
					.meta({
						description: "Whether the dependent pins an exact version.",
					})
					.exactOptional(),
				reason: z
					.string()
					.meta({ description: "Why the edge exists." })
					.exactOptional(),
			}),
		)
		.meta({ description: "Extra dependency edges between units." })
		.exactOptional(),
	ignore: globs.meta({
		description: "Globs of files that never affect any unit, for example docs.",
	}),
	globalInputs: globs.meta({
		description:
			"Globs of files whose change affects all units, unioned with plugin defaults.",
	}),
	branches: z
		.array(
			z.strictObject({
				name: z.string().meta({
					description:
						"Branch name pattern; supports * and the captures {major} and {minor}.",
				}),
				line: z.enum(["default", "maintenance"]).meta({
					description: "Release line of matching branches.",
				}),
				channel: z
					.string()
					.meta({
						description:
							"Prerelease channel (letters, digits, dash); may use {major} and {minor} captured by name.",
					})
					.exactOptional(),
				unit: z
					.string()
					.meta({
						description:
							"Maintenance rules: ungrouped released unit whose version must be on the line captured by name. Excludes group.",
					})
					.exactOptional(),
				group: z
					.string()
					.meta({
						description:
							"Maintenance rules: fixed group whose version must be on the line captured by name. Excludes unit.",
					})
					.exactOptional(),
			}),
		)
		.meta({
			description: "Branch rules; the first rule matching the branch wins.",
		})
		.exactOptional(),
	bumps: z
		.strictObject({
			types: z
				.record(z.string(), bumpLevel)
				.meta({
					description:
						"Commit type to bump level, merged over feat: minor, fix: patch, perf: patch, revert: patch. Breaking changes bump major.",
				})
				.exactOptional(),
			preMajor: z
				.strictObject({
					breaking: bumpLevel
						.meta({
							description: "Bump level for breaking changes. Default minor.",
						})
						.exactOptional(),
					feat: bumpLevel
						.meta({ description: "Bump level for feat. Default minor." })
						.exactOptional(),
				})
				.meta({
					description:
						"Bump levels for breaking changes and feat while the major version is 0. Default minor for both.",
				})
				.exactOptional(),
			absorbed: z
				.enum(["patch", "minor"])
				.meta({
					description:
						"Level a released unit gets from bump-producing changes absorbed from unreleased dependencies: patch (default) or minor (feat and breaking give minor, fix gives patch).",
				})
				.exactOptional(),
		})
		.meta({ description: "How commits map to bump levels." })
		.exactOptional(),
	groups: z
		.record(unitId, groupSchema)
		.refine((groups) => Object.keys(groups).length > 0, {
			message: "groups needs at least one group",
		})
		.meta({
			description:
				"Fixed groups by name (unit id characters): members release together with one version. Each group needs units, tags or both.",
			minProperties: 1,
		})
		.exactOptional(),
	tags: z
		.strictObject({
			floating: z
				.array(z.string())
				.meta({
					description:
						"Floating tag formats moved to the highest stable release they render for; tokens {id}, {major} and {minor}.",
				})
				.exactOptional(),
		})
		.meta({ description: "Tags beyond the version tag of each release." })
		.exactOptional(),
});

/** Schema of `tallyrelease.yaml`; the parsed output drops `$schema`. */
export const configSchema = configObject.transform(
	({ $schema: _, ...config }) => config,
);

/** `tallyrelease.yaml` as read by the cli: `TallyConfig` plus the cli-owned plugin keys. */
export type CliConfig = z.output<typeof configSchema>;

/** A `plugins.<name>` entry with the cli-owned keys. */
export type PluginEntry = z.output<typeof pluginEntry>;

// Fails to compile when the schema misses or adds a field of `TallyConfig`.
export const configSchemaExact: Equals<
	Omit<CliConfig, "plugins">,
	Omit<TallyConfig, "plugins">
> = true;

// Plugin entries without the cli-owned keys are `TallyConfig` plugin entries.
export const pluginEntryExact: Equals<
	Omit<PluginEntry, "path" | "package">,
	NonNullable<TallyConfig["plugins"][string]>
> = true;

// The schema requires `units` or `tags`; `GroupConfig` does not, so only field names are compared.
export const groupSchemaFields: Equals<
	Keys<z.output<typeof groupUnion>>,
	keyof GroupConfig
> = true;

/** JSON schema (draft-07) of `tallyrelease.yaml` as published for editors. */
export const configJsonSchema = () => ({
	...z.toJSONSchema(configSchema, { target: "draft-7", io: "input" }),
	$id: "https://cdn.jsdelivr.net/npm/@tallyrelease/cli@0/dist/tallyrelease.schema.json",
	title: "tallyrelease.yaml",
});
