import { TallyError } from "@tallyrelease/core";

import type { RepoRef } from "../forge/forge.js";
import type { Session } from "../session.js";
import type { PlanLine } from "@tallyrelease/core";

const PR_EVENTS = new Set([
	"pull_request",
	"pull_request_target",
	"merge_group",
]);

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
	const event = session.github?.eventName;
	const reason =
		event !== undefined && PR_EVENTS.has(event)
			? `on ${event} events`
			: line?.line === null
				? `on branch "${line.branch}" without a line rule`
				: undefined;
	if (reason !== undefined) {
		session.warn([
			{
				code: "W_EFFECT_SKIPPED",
				message: `${command} does nothing ${reason}`,
			},
		]);
	}

	return reason !== undefined;
};

/** `GITHUB_REPOSITORY`, else owner and name from the repository URL. */
export const repoRef = async (session: Session): Promise<RepoRef> => {
	const [owner, repo] =
		session.env["GITHUB_REPOSITORY"]?.split("/") ??
		(await session.repoUrl())?.split("/").slice(-2) ??
		[];
	if (!owner || !repo) {
		throw new TallyError(
			"E_NO_FORGE",
			`the forge repository is unknown; set GITHUB_REPOSITORY or an ${session.remote} remote`,
		);
	}

	return { owner, repo };
};
