import { computePlan, releaseFiles, releaseItems } from "@tallyrelease/core";

import { effectSkipped } from "../app/effects.js";
import { planOptions } from "../app/setup.js";
import { versionText } from "../render/version.js";

import type { Session } from "../session.js";

export interface VersionFlags {
	branch?: string;
	dryRun?: boolean;
}

/**
 * Writes version files and changelogs of all pending release items to the
 * working tree, deletes the files the release removes and prints the changed
 * paths.
 */
export const applyVersions = async (
	session: Session,
	flags: VersionFlags,
): Promise<void> => {
	if (effectSkipped(session, "version")) {
		return;
	}

	const setup = await planOptions(session, flags);
	const repoUrl = await session.repoUrl();
	const date = session.clock().toISOString().slice(0, 10);
	const result = await session.workspaceAt(null, async (workspace, fs) => {
		const plan = await computePlan(workspace, session.git, {
			...setup.opts,
			fs,
			all: true,
		});
		if (effectSkipped(session, "version", plan)) {
			return undefined;
		}

		const written = await releaseFiles(workspace, plan, {
			fs,
			items: releaseItems(workspace, plan),
			repoUrl,
			date,
		});

		return {
			files: written.files,
			deletes: written.deletes,
			warnings: [...plan.warnings, ...setup.warnings, ...written.warnings],
		};
	});
	if (result === undefined) {
		return;
	}

	const { files, deletes, warnings } = result;
	session.warn(warnings);

	if (!flags.dryRun) {
		for (const [path, content] of files) {
			session.writeFile(path, content);
		}

		for (const path of deletes) {
			session.deleteFile(path);
		}
	}

	session.stdout.write(
		versionText([...files.keys()], [...deletes], flags.dryRun),
	);
};
