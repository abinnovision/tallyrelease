import {
	validateRelease,
	validateTags,
	versionFileClaims,
} from "@tallyrelease/core";

import { checkText } from "../render/check.js";

import type { Session } from "../session.js";

/**
 * Validates config, plugins, units, graph and release config; with released
 * units also the repository's tags.
 */
export const check = async (session: Session): Promise<void> => {
	const workspace = await session.workspace();
	session.warn(workspace.warnings);
	validateRelease(workspace);
	await versionFileClaims(workspace);
	const released = workspace.units
		.filter((u) => u.version !== "none")
		.map((u) => u.id);
	if (released.length > 0) {
		session.warn(validateTags(workspace, await session.git.tags()));
	}

	session.stdout.write(
		checkText({
			units: workspace.units.length,
			released,
			edges: workspace.graph.edges.length,
		}),
	);
};
