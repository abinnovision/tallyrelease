import type { Session } from "../session.js";

/** Appends markdown to `$GITHUB_STEP_SUMMARY`; false when it is not set. */
export const appendStepSummary = (
	session: Pick<Session, "env" | "appendFile">,
	markdown: string,
): boolean => {
	const path = session.env["GITHUB_STEP_SUMMARY"];
	if (!path) {
		return false;
	}

	session.appendFile(path, markdown);

	return true;
};
