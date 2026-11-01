import { computeAffected } from "@tallyrelease/core";

import { toJson, writeAffected } from "../app/outputs.js";
import { resolveBuildBase } from "../ci/base.js";
import { cliCodes } from "../codes.js";
import { painter } from "../output/paint.js";
import { affectedText, affectedTsv } from "../render/affected.js";
import { branchName } from "../session.js";
import { version } from "../version.js";

import type { Session } from "../session.js";

export interface AffectedFlags {
	base?: string;
	format?: "text" | "json" | "tsv";
	json?: boolean;
	out?: string;
	githubOutput?: boolean;
	/** Keeps units with at least one of these tags. */
	tag?: string[];
}

/** Computes the build set and writes the requested outputs. */
export const affected = async (
	session: Session,
	flags: AffectedFlags,
): Promise<void> => {
	const { git, ci } = session;
	const workspace = await session.workspace();
	const head = await git.resolve("HEAD");
	if (head === undefined) {
		throw cliCodes.error(
			"E_NO_HEAD",
			"HEAD does not resolve to a commit; the repository has no commits",
		);
	}

	const base = await resolveBuildBase({
		git,
		head,
		env: session.env,
		cliBase: flags.base,
		event: ci.event,
		baseInputs: ci.baseInputs,
		forge: session.forge,
		remote: session.remote,
	});
	const computed = await computeAffected(workspace, git, {
		tool: `tallyrelease@${version}`,
		branch: await branchName(session),
		head,
		base: base.base,
		baseSource: base.source,
	});
	const tags = new Set(flags.tag ?? []);
	const known = new Set(workspace.units.flatMap((u) => u.tags));
	const unknownTags = [...tags]
		.filter((t) => !known.has(t))
		.map((t) => cliCodes.warning("W_TAG_UNKNOWN", `no unit has tag "${t}"`));
	const selected = (u: { tags: readonly string[] }) =>
		tags.size === 0 || u.tags.some((t) => tags.has(t));
	const doc = {
		...computed,
		units: computed.units.filter(selected),
		warnings: [...computed.warnings, ...base.warnings, ...unknownTags],
	};
	session.warn(doc.warnings);

	writeAffected(session, doc, flags);

	const format = flags.format ?? (flags.json ? "json" : "text");
	if (format === "json") {
		session.stdout.write(toJson(doc));

		return;
	}

	if (format === "tsv") {
		session.stdout.write(affectedTsv(doc));

		return;
	}

	session.stdout.write(
		affectedText(
			{ doc, base, total: workspace.units.filter(selected).length },
			painter(session.stdout),
		),
	);
};
