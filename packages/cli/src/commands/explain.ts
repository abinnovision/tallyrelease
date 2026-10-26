import { explainUnit } from "@tallyrelease/core";

import { planOptions } from "../app/setup.js";
import { painter } from "../output/paint.js";
import { explainText } from "../render/explain.js";

import type { PlanFlags } from "../app/setup.js";
import type { Session } from "../session.js";

export type ExplainFlags = Pick<PlanFlags, "branch" | "base">;

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

	session.stdout.write(
		explainText({ id, unit, explanation, base }, painter(session.stdout)),
	);
};
