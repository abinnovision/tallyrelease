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
		/** PR that merged the release sha. */
		pr: z.strictObject({ number: z.number(), url: z.string() }).nullable(),
		/** Forge release of the tag. */
		release: z.strictObject({ url: z.string() }).nullable(),
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
		}),
	),
	released: z.array(
		z.strictObject({
			id: z.string(),
			path: z.string(),
			version: z.string(),
			tag: z.string(),
			floatingTags: z.array(z.string()),
			releaseSha: z.string(),
			catchUp: z.boolean(),
			forge: forgeSchema,
			line: z.enum(["default", "maintenance"]),
			latest: z.boolean(),
		}),
	),
}) satisfies z.ZodType<Plan>;

// Fails to compile when the schema misses or adds a field of `Plan`.
export const planSchemaExact: Equals<z.infer<typeof planSchema>, Plan> = true;

/** One entry of the `releases` output of `run --github-output`. */
export const releaseEntrySchema = z.strictObject({
	id: z.string(),
	path: z.string(),
	kind: z.enum(["release", "prerelease"]),
	version: z.string(),
	channel: z.string().nullable(),
	tag: z.string().nullable(),
	releaseSha: z.string(),
	/** Not built from HEAD by this run (release sha differs from HEAD, or the unit is outside the build set). */
	catchUp: z.boolean(),
	/** Null for prereleases. */
	forge: forgeSchema,
	/** Highest stable version tagged for the unit, never on a maintenance line; false for prereleases. */
	latest: z.boolean(),
	/** Own changes, then those of the units it was propagated from (transitively), `via` naming the owning unit; of a prerelease, those since the last stable release. */
	changes: z.array(changeSchema),
	/** Sorted unit tags. */
	tags: z.array(z.string()),
	/** Fixed group of the unit. */
	group: z.string().nullable(),
});

export type ReleaseEntry = z.infer<typeof releaseEntrySchema>;
