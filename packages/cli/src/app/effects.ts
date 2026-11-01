import { cliCodes } from "../codes.js";

import type { RepoRef } from "../forge/forge.js";
import type { Session } from "../session.js";
import type { PlanLine } from "@tallyrelease/core";

/**
 * True, with `W_EFFECT_SKIPPED`, when an effect command must do nothing: on
 * pull request and merge queue events, or on a branch without a line rule
 * (pass `line` once planned).
 */
export const effectSkipped = (
	session: Session,
	command: string,
	line?: { branch: string; line: PlanLine | null },
): boolean => {
	const { event, prEvent } = session.ci;
	const reason =
		prEvent && event !== undefined
			? `on ${event.name} events`
			: line?.line === null
				? `on branch "${line.branch}" without a line rule`
				: undefined;
	if (reason !== undefined) {
		session.warn([
			cliCodes.warning("W_EFFECT_SKIPPED", `${command} does nothing ${reason}`),
		]);
	}

	return reason !== undefined;
};

/** The CI repository, else owner and name from the repository URL. */
export const repoRef = async (session: Session): Promise<RepoRef> => {
	const [owner, repo] =
		session.ci.repository?.split("/") ??
		(await session.repoUrl())?.split("/").slice(-2) ??
		[];
	if (!owner || !repo) {
		throw cliCodes.error(
			"E_NO_FORGE",
			`the forge repository is unknown; set GITHUB_REPOSITORY or an ${session.remote} remote`,
		);
	}

	return { owner, repo };
};
