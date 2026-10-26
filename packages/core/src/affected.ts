import { attribution, matcher } from "./attribution.js";
import { changelogPath } from "./changelog.js";
import { uniqueSorted } from "./util.js";

import type {
	AffectedDoc,
	AffectedOptions,
	AffectedReason,
	AffectedUnit,
} from "./model/affected-types.js";
import type { GitReader, Unit } from "./plugin.js";
import type { Workspace } from "./workspace.js";

/** Computes the build set for `base..head` from a tree-to-tree diff. */
export const computeAffected = async (
	workspace: Workspace,
	git: GitReader,
	opts: AffectedOptions,
): Promise<AffectedDoc> => {
	const { units, graph } = workspace;
	const doc = (
		affected: AffectedUnit[],
		build: { all: boolean; globalInputs: string[] },
		unattributed: string[],
	): AffectedDoc => ({
		schema: 1,
		tool: opts.tool,
		repo: workspace.repo,
		branch: opts.branch,
		head: opts.head,
		build: { base: opts.base, baseSource: opts.baseSource, ...build },
		units: affected,
		unattributed,
		warnings: [...workspace.warnings],
	});
	const entry = (
		u: Unit,
		reason: AffectedReason,
		via: string[],
	): AffectedUnit => ({
		id: u.id,
		path: u.root,
		plugin: u.plugin,
		reason,
		via,
		released: u.version !== "none",
		tags: [...u.tags],
	});
	const everything = (reason: AffectedReason): AffectedUnit[] =>
		units.map((u) => entry(u, reason, []));

	if (opts.base === null) {
		return doc(everything("all"), { all: true, globalInputs: [] }, []);
	}

	const ignored = matcher(workspace.ignore);
	const isGlobal = matcher(workspace.globalInputs);
	const owners = attribution(units);
	// A released unit owns its changelog regardless of ignore, include and exclude.
	const changelogs = new Map(
		units
			.filter((u) => u.version !== "none")
			.map((u) => [changelogPath(u), u.id]),
	);

	const files = (await git.diffFiles(opts.base, opts.head)).filter(
		(f) => changelogs.has(f) || !ignored(f),
	);
	const hits = uniqueSorted(files.filter(isGlobal));
	const direct = new Set<string>();
	const unattributed: string[] = [];
	for (const file of files) {
		if (isGlobal(file)) {
			continue;
		}

		const own = changelogs.get(file);
		const ids = own === undefined ? owners(file) : [own];
		if (ids.length === 0) {
			unattributed.push(file);
		}

		for (const id of ids) {
			direct.add(id);
		}
	}

	if (hits.length > 0) {
		return doc(
			everything("global"),
			{ all: true, globalInputs: hits },
			uniqueSorted(unattributed),
		);
	}

	const mates = new Map(
		workspace.groups.flatMap((g) =>
			g.members.map((id) => [id, g.members.filter((m) => m !== id)]),
		),
	);
	const affected = new Set(direct);
	const queue = [...direct];
	for (const id of queue) {
		for (const next of [
			...(graph.dependents.get(id) ?? []),
			...(mates.get(id) ?? []),
		]) {
			if (!affected.has(next)) {
				affected.add(next);
				queue.push(next);
			}
		}
	}

	// Precedence: direct, then dependent, then group.
	const result = units
		.filter((u) => affected.has(u.id))
		.map((u) => {
			if (direct.has(u.id)) {
				return entry(u, "direct", []);
			}

			const deps = (graph.dependencies.get(u.id) ?? []).filter((d) =>
				affected.has(d),
			);

			return deps.length > 0
				? entry(u, "dependent", deps)
				: entry(
						u,
						"group",
						(mates.get(u.id) ?? []).filter((m) => affected.has(m)),
					);
		});

	return doc(
		result,
		{ all: false, globalInputs: [] },
		uniqueSorted(unattributed),
	);
};
