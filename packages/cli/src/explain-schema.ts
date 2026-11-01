import { z } from "zod";

import { affectedDocSchema } from "./affected-schema.js";
import { planSchema } from "./plan-schema.js";

import type { Equals } from "./types.js";
import type { UnitExplanation } from "@tallyrelease/core";

const unitSchema = planSchema.shape.units.element;

/** Document of `tallyrelease explain --json`: the explanation without its plan. */
export interface ExplainDoc extends Omit<UnitExplanation, "plan"> {
	schema: 1;
}

/** Schema of `tallyrelease explain --json`, published as `explain.schema.json`. */
export const explainSchema = z.strictObject({
	schema: z.literal(1),
	unit: unitSchema.nullable(),
	group: z
		.strictObject({ name: z.string(), members: z.array(z.string()) })
		.nullable(),
	introduced: z.string().nullable(),
	nextSource: z.enum(["bump", "initial", "release-as"]).nullable(),
	files: z.array(z.string()),
	changes: z.array(
		unitSchema.shape.changes.element.extend({ files: z.array(z.string()) }),
	),
	propagatedFrom: z.array(
		z.strictObject({ id: z.string(), pinned: z.boolean().nullable() }),
	),
	releaseAs: z.array(
		z.strictObject({
			sha: z.string().exactOptional(),
			version: z.string(),
			qualified: z.boolean(),
			applied: z.boolean(),
		}),
	),
	warnings: affectedDocSchema.shape.warnings,
}) satisfies z.ZodType<ExplainDoc>;

// Fails to compile when the schema misses or adds a field of `ExplainDoc`.
export const explainSchemaExact: Equals<
	z.infer<typeof explainSchema>,
	ExplainDoc
> = true;
