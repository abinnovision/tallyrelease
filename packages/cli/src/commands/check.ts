import {
	computePlan,
	validateRelease,
	validateTags,
	versionFileClaims,
} from "@tallyrelease/core";

import { planOptions } from "../app/setup.js";
import { checkText } from "../render/check.js";

import type { PlanFlags } from "../app/setup.js";
import type { Session } from "../session.js";

export type CheckFlags = Pick<PlanFlags, "branch" | "head">;

/**
 * Validates config, plugins, units, graph and release config; with released
 * units also the repository's tags. Then plans all units, which runs the
 * plugins' `validate` hooks, and reports their warnings.
 */
export const check = async (
	session: Session,
	flags: CheckFlags,
): Promise<void> => {
	// Surfaces directory, repository and config errors before git is read.
	await session.workspace();
	const { opts, ref, warnings } = await planOptions(session, flags);
	session.warn(warnings);
	await session.workspaceAt(ref, async (workspace, files) => {
		session.warn(workspace.warnings);
		validateRelease(workspace);
		await versionFileClaims(workspace);
		const released = workspace.units
			.filter((u) => u.version !== "none")
			.map((u) => u.id);
		if (released.length > 0) {
			session.warn(validateTags(workspace, await session.git.tags()));
		}

		const plan = await computePlan(workspace, session.git, {
			...opts,
			fs: files,
			all: true,
		});
		session.warn(
			plan.warnings.filter(
				(w) => w.code === "W_PLUGIN" && !workspace.warnings.includes(w),
			),
		);

		session.stdout.write(
			checkText({
				units: workspace.units.length,
				released,
				edges: workspace.graph.edges.length,
			}),
		);
	});
};
