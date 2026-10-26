import { painter } from "../output/paint.js";
import { graphText } from "../render/graph.js";
import { renderMermaid } from "../render/mermaid.js";

import type { Session } from "../session.js";

export interface GraphFlags {
	format?: "text" | "json" | "mermaid";
	json?: boolean;
}

/** Prints units and edges. */
export const graph = async (
	session: Session,
	flags: GraphFlags,
): Promise<void> => {
	const workspace = await session.workspace();
	session.warn(workspace.warnings);

	const units = workspace.units.map((u) => ({
		id: u.id,
		path: u.root,
		plugin: u.plugin,
		version: u.version,
		tags: [...u.tags],
	}));
	const edges = workspace.graph.edges.map((e) => ({
		from: e.from,
		to: e.to,
		pinned: e.pinned,
		reasons: e.reasons,
	}));

	const format = flags.format ?? (flags.json ? "json" : "text");

	if (format === "mermaid") {
		session.stdout.write(renderMermaid(units, edges));

		return;
	}

	if (format === "json") {
		session.stdout.write(
			`${JSON.stringify({ repo: workspace.repo, units, edges }, null, 2)}\n`,
		);

		return;
	}

	session.stdout.write(
		graphText(
			{
				units,
				edges: edges.length,
				dependents: (id) => workspace.graph.dependents.get(id) ?? [],
			},
			painter(session.stdout),
		),
	);
};
