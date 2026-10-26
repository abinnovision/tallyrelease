import { TallyError } from "@tallyrelease/core";

import { writePlan } from "../app/outputs.js";
import { planOptions, releasedForge } from "../app/setup.js";
import { cliCodes } from "../codes.js";

import type { PlanFlags } from "../app/setup.js";
import type { Session } from "../session.js";
import type { Warning } from "@tallyrelease/core";

/** Computes the release plan and writes the requested outputs. */
export const plan = async (
	session: Session,
	flags: PlanFlags,
): Promise<void> => {
	const { opts, ref, base, warnings } = await planOptions(session, flags);
	const planned = await session.planAt(
		ref,
		{ ...opts, all: flags.all ?? false },
		{ released: true },
	);
	// A forge request failure leaves `forge` null; plan stays lenient.
	let { released } = planned;
	const prWarnings: Warning[] = [];
	try {
		released = await releasedForge(session, released);
	} catch (error) {
		if (error instanceof TallyError) {
			throw error;
		}

		prWarnings.push(
			cliCodes.warning(
				"W_FORGE_ERROR",
				`cannot read the PRs and releases of released commits: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
	}

	const doc = {
		...planned,
		released,
		warnings: [...planned.warnings, ...warnings, ...prWarnings],
	};
	session.warn(doc.warnings);
	writePlan(session, { doc, base }, flags);
};
