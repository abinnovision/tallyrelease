// Writes JSON schemas generated from the built zod schemas into dist.
import { writeFileSync } from "node:fs";
import { z } from "zod";

import { affectedDocSchema } from "../dist/affected-schema.js";
import { configJsonSchema } from "../dist/config/schema.js";
import { explainSchema } from "../dist/explain-schema.js";
import { planSchema } from "../dist/plan-schema.js";

writeFileSync(
	new URL("../dist/affected.schema.json", import.meta.url),
	`${JSON.stringify(z.toJSONSchema(affectedDocSchema), null, "\t")}\n`,
);

writeFileSync(
	new URL("../dist/explain.schema.json", import.meta.url),
	`${JSON.stringify(z.toJSONSchema(explainSchema), null, "\t")}\n`,
);

writeFileSync(
	new URL("../dist/plan.schema.json", import.meta.url),
	`${JSON.stringify(z.toJSONSchema(planSchema), null, "\t")}\n`,
);

writeFileSync(
	new URL("../dist/tallyrelease.schema.json", import.meta.url),
	`${JSON.stringify(configJsonSchema(), null, "\t")}\n`,
);
