import {
	computePlan,
	releaseFiles,
	releaseItems,
	versionFileClaims,
} from "@tallyrelease/core";

import { effectSkipped } from "../app/effects.js";
import { buildChannel, resolveHead } from "../app/setup.js";
import { cliCodes } from "../codes.js";
import { versionText } from "../render/version.js";
import { branchName } from "../session.js";
import { version } from "../version.js";

import type { Session } from "../session.js";
import type {
	Plan,
	ReadonlyFs,
	ReleaseItem,
	Workspace,
} from "@tallyrelease/core";

export interface VersionFlags {
	branch?: string;
	dryRun?: boolean;
}

/**
 * Items at their prerelease version. Items whose plugin version files all
 * hold `next` are left out, since HEAD is their release commit; so are items
 * without a prerelease.
 */
const buildItems = async (
	workspace: Workspace,
	plan: Plan,
	fs: ReadonlyFs,
): Promise<ReleaseItem[]> => {
	const claims = await versionFileClaims(workspace);
	const units = new Map(plan.units.map((u) => [u.id, u]));
	const groups = new Map(plan.groups.map((g) => [g.name, g]));

	return releaseItems(workspace, plan).flatMap((item) => {
		const files = item.units.flatMap((id) => claims.get(id) ?? []);
		const released =
			files.length > 0 &&
			files.every((f) => {
				const content = fs.read(f.path);

				return content !== undefined && f.read(content) === item.next;
			});
		const prerelease =
			item.kind === "group"
				? groups.get(item.name)?.version
				: units.get(item.units[0] ?? "")?.version;

		return released || !prerelease ? [] : [{ ...item, version: prerelease }];
	});
};

/**
 * Writes the versions of the build at HEAD (prereleases of every pending
 * unit, planned without a base) into version files, templates and markers
 * of the working tree and prints the changed paths.
 */
export const applyVersions = async (
	session: Session,
	flags: VersionFlags,
): Promise<void> => {
	if (effectSkipped(session, "version")) {
		return;
	}

	const head = await resolveHead(session);
	if (await session.git.isShallow()) {
		throw cliCodes.error(
			"E_BUILD_NUMBER_SHALLOW",
			"prerelease and build numbers count first-parent commits, which this shallow clone truncates; fetch the full history",
		);
	}

	const branch = flags.branch ?? (await branchName(session));
	const opts = {
		tool: `tallyrelease@${version}`,
		branch,
		head,
		base: null,
		baseSource: "none" as const,
		buildChannel: await buildChannel(session, branch),
	};
	const result = await session.workspaceAt(null, async (workspace, fs) => {
		const plan = await computePlan(workspace, session.git, { ...opts, fs });
		if (effectSkipped(session, "version", plan)) {
			return undefined;
		}

		const written = await releaseFiles(workspace, plan, {
			fs,
			items: await buildItems(workspace, plan, fs),
			changelogs: false,
		});

		return {
			files: written.files,
			warnings: [...plan.warnings, ...written.warnings],
		};
	});
	if (result === undefined) {
		return;
	}

	const { files, warnings } = result;
	session.warn(warnings);

	if (!flags.dryRun) {
		for (const [path, content] of files) {
			session.writeFile(path, content);
		}
	}

	session.stdout.write(versionText([...files.keys()], flags.dryRun));
};
