import type { EdgeDraft, Unit } from "@tallyrelease/core";

/** Units of `plugin` keyed by package name; `onDuplicate` sees each shadowed unit. */
export const unitsByPackage = (
	units: readonly Unit[],
	plugin: string,
	onDuplicate?: (name: string, prior: Unit, next: Unit) => void,
): Map<string, Unit> => {
	const byName = new Map<string, Unit>();
	for (const unit of units) {
		const name = unit.meta[plugin]?.["packageName"];
		if (unit.plugin === plugin && typeof name === "string") {
			const prior = byName.get(name);
			if (prior) {
				onDuplicate?.(name, prior, unit);
			}

			byName.set(name, unit);
		}
	}

	return byName;
};

/** The edge `from` -> `to`; empty when `from` is unknown or the same unit. */
export const edgeBetween = (
	from: Unit | undefined,
	to: Unit,
	link: Pick<EdgeDraft, "reason" | "pinned">,
): EdgeDraft[] =>
	from && from.id !== to.id ? [{ from: from.id, to: to.id, ...link }] : [];

/** Edges for each entry of `deps` that names a unit in `byName`; `exact` marks pinned ranges. */
export const dependencyEdges = (
	byName: ReadonlyMap<string, Unit>,
	to: Unit,
	{
		field,
		deps,
		exact,
	}: { field: string; deps: Record<string, string>; exact: RegExp | undefined },
): EdgeDraft[] =>
	Object.entries(deps).flatMap(([name, range]) =>
		edgeBetween(byName.get(name), to, {
			reason: `${field}: ${name}`,
			pinned: exact?.test(range) ?? false,
		}),
	);
