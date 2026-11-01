import { explainUnit } from "@tallyrelease/core";

import { toJson } from "../app/outputs.js";
import { planOptions } from "../app/setup.js";
import { painter } from "../output/paint.js";
import { explainText } from "../render/explain.js";

import type { PlanFlags } from "../app/setup.js";
import type { ExplainDoc } from "../explain-schema.js";
import type { Session } from "../session.js";

export type ExplainFlags = Pick<
	PlanFlags,
	"branch" | "base" | "format" | "json"
>;

/** Explains why a unit is affected and how its version is computed. */
export const explain = async (
	session: Session,
	id: string,
	flags: ExplainFlags,
): Promise<void> => {
	const { opts, ref, base, warnings } = await planOptions(session, flags);
	const { explanation, unit } = await session.workspaceAt(
		ref,
		async (workspace, fs) => ({
			explanation: await explainUnit(workspace, session.git, {
				...opts,
				fs,
				unit: id,
			}),
			unit: workspace.units.find((u) => u.id === id),
		}),
	);
	session.warn([...explanation.warnings, ...warnings]);

	const format = flags.format ?? (flags.json ? "json" : "text");
	if (format === "json") {
		const { plan: _plan, ...rest } = explanation;
		session.stdout.write(toJson({ schema: 1, ...rest } satisfies ExplainDoc));

		return;
	}

	session.stdout.write(
		explainText({ id, unit, explanation, base }, painter(session.stdout)),
	);
};
