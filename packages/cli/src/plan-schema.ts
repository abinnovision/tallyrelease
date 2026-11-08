import { z } from "zod";

import { affectedDocSchema } from "./affected-schema.js";

import type { Equals } from "./types.js";
import type { Plan } from "@tallyrelease/core";

const bump = z.enum(["major", "minor", "patch"]);

const changeSchema = z.strictObject({
	sha: z.string().exactOptional(),
	type: z.string(),
	breaking: z.boolean(),
	scope: z.string().exactOptional(),
	subject: z.string(),
	notes: z.string().exactOptional(),
	pr: z.number().exactOptional(),
	/** Unit that owns the change when it is not this unit's: absorbed, or propagated in a release entry. */
	via: z.string().exactOptional(),
	releaseAs: z.string().exactOptional(),
	/** Units the change names; set with `files`. */
	units: z.array(z.string()).exactOptional(),
	/** Files consumed once every unit named by the changes with them releases. */
	files: z.array(z.string()).exactOptional(),
});

/** Null when not looked up (no forge, or a forge error in `plan`). */
const forgeSchema = z
	.strictObject({
		pr: z
			.strictObject({ number: z.number(), url: z.string() })
			.nullable()
			.describe("PR that merged the release commit, else null."),
		release: z
			.strictObject({ url: z.string() })
			.nullable()
			.describe(
				"Forge release of the tag, else null. Null also for a release that a dry run would create.",
			),
	})
	.nullable();

/** Schema of `tallyrelease plan --json`, published as `plan.schema.json`. */
export const planSchema = z.strictObject({
	...affectedDocSchema.omit({ units: true }).shape,
	line: z
		.strictObject({
			rule: z.string(),
			kind: z.enum(["default", "maintenance"]),
			channel: z.string().nullable(),
			channelKind: z.enum(["build", "nightly"]).nullable(),
			cut: z.string().nullable(),
			maxBump: z.enum(["minor", "patch"]).nullable(),
			absolute: z
				.strictObject({
					unit: z.string().nullable(),
					group: z.string().nullable(),
					major: z.number(),
					minor: z.number().exactOptional(),
				})
				.nullable(),
		})
		.nullable(),
	units: z.array(
		z.strictObject({
			id: z.string(),
			path: z.string(),
			plugin: z.string(),
			scheme: z.string(),
			tags: z.array(z.string()),
			group: z.string().nullable(),
			affected: z
				.strictObject({
					reason: affectedDocSchema.shape.units.element.shape.reason,
					via: z.array(z.string()),
				})
				.nullable(),
			kind: z.enum(["prerelease", "rebuild", "none"]),
			baseTag: z.string().nullable(),
			lineBaseTag: z.string().nullable(),
			from: z.string().nullable(),
			bump: bump.nullable(),
			releaseAs: z.string().nullable(),
			propagatedFrom: z.array(z.string()),
			absorbedFrom: z.array(z.string()),
			next: z.string().nullable(),
			version: z.string().nullable(),
			cut: z.string().nullable(),
			sha: z.string(),
			changes: z.array(changeSchema),
		}),
	),
	groups: z.array(
		z.strictObject({
			name: z.string(),
			members: z.array(z.string()),
			baseTag: z.string().nullable(),
			from: z.string().nullable(),
			bump: bump.nullable(),
			next: z.string().nullable(),
			version: z.string().nullable(),
			cut: z.string().nullable(),
		}),
	),
	released: z.array(
		z.strictObject({
			id: z.string(),
			path: z.string(),
			version: z.string(),
			tag: z.string(),
			releaseTag: z.string(),
			floatingTags: z.array(z.string()),
			releaseSha: z.string(),
			catchUp: z.boolean(),
			forge: forgeSchema,
			line: z.enum(["default", "maintenance"]),
			/** A cut: a prerelease tag of the line's cut channel. */
			prerelease: z.boolean(),
			latest: z.boolean(),
		}),
	),
}) satisfies z.ZodType<Plan>;

// Fails to compile when the schema misses or adds a field of `Plan`.
export const planSchemaExact: Equals<z.infer<typeof planSchema>, Plan> = true;

export const releaseEntrySchema = z
	.strictObject({
		id: z.string().describe("Unit id."),
		path: z.string().describe("Unit root."),
		kind: z
			.enum(["release", "prerelease"])
			.describe(
				"`release` for a stable release, `prerelease` for a build or cut prerelease.",
			),
		version: z
			.string()
			.describe("Released version, or the prerelease version of the plan."),
		channel: z
			.string()
			.nullable()
			.describe(
				"Build, nightly or cut channel of a prerelease, null for a release.",
			),
		tag: z
			.string()
			.nullable()
			.describe(
				"Version tag of a release or cut prerelease, null for a build prerelease.",
			),
		releaseTag: z
			.string()
			.nullable()
			.describe(
				"Tag of the forge release: the group's `releaseTag` for a member of a group that sets it, else `tag`; null for a build prerelease.",
			),
		releaseSha: z
			.string()
			.describe(
				"Full sha of the tagged commit, or HEAD for a build prerelease.",
			),
		catchUp: z
			.boolean()
			.describe(
				"True when not built from HEAD by this run: the release commit is not HEAD, or the unit is outside the build set.",
			),
		forge: forgeSchema.describe(
			"PR and forge release looked up on the forge, null for a build prerelease or without a forge.",
		),
		latest: z
			.boolean()
			.describe(
				"True for the unit's highest stable tag, never on a maintenance line; false for prereleases.",
			),
		changes: z
			.array(changeSchema)
			.describe(
				"Changes in the shape of the plan's `units[].changes`: the unit's own, then those of the units it was propagated from (transitively), with `via` naming the owning unit. For a prerelease, those since the last stable release.",
			),
		tags: z.array(z.string()).describe("Sorted unit tags."),
		group: z
			.string()
			.nullable()
			.describe("Fixed group of the unit, else null."),
		line: z
			.enum(["default", "maintenance"])
			.describe("Line of the planned branch."),
		buildNumber: z
			.int()
			.nullable()
			.describe(
				"First-parent commit count of `releaseSha` plus the unit's `buildNumber.offset`, null for a unit without `buildNumber`. Not part of the version.",
			),
	})
	.describe("One entry of the `releases` output of `run --github-output`.");

export type ReleaseEntry = z.infer<typeof releaseEntrySchema>;
