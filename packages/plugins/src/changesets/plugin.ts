import { definePlugin } from "@tallyrelease/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { Change, Ctx, Unit } from "@tallyrelease/core";

const FRONTMATTER =
	/^\uFEFF?\s*---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

type Kind = Pick<Change, "type" | "breaking">;

const KINDS = new Map<unknown, Kind>([
	["major", { type: "feat", breaking: true }],
	["minor", { type: "feat", breaking: false }],
	["patch", { type: "fix", breaking: false }],
]);

/** Unit id by unit id, then by any `meta.*.packageName`. */
const unitKeys = (units: readonly Unit[]): Map<string, string> => {
	const keys = new Map(units.map((u) => [u.id, u.id]));
	for (const unit of units) {
		for (const meta of Object.values(unit.meta)) {
			const name = meta["packageName"];
			if (typeof name === "string" && !keys.has(name)) {
				keys.set(name, unit.id);
			}
		}
	}

	return keys;
};

/**
 * Changes of one changeset, one per bump level; none without frontmatter,
 * which warns except for `README.md`.
 */
const changesOf = (
	ctx: Ctx,
	path: string,
	keys: ReadonlyMap<string, string>,
): Change[] => {
	const content = ctx.fs.read(path);
	if (content === undefined) {
		return [];
	}

	const match = FRONTMATTER.exec(content);
	if (!match) {
		if (path !== ".changeset/README.md") {
			ctx.log.warn(`${path} has no frontmatter`);
		}

		return [];
	}

	let bumps: unknown;
	try {
		bumps = parseYaml(match[1] ?? "") ?? {};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`invalid frontmatter in ${path}: ${reason}`, {
			cause: error,
		});
	}

	if (typeof bumps !== "object" || bumps === null || Array.isArray(bumps)) {
		throw new Error(`frontmatter of ${path} must map packages to bumps`);
	}

	const byKind = new Map<Kind, string[]>();
	for (const [key, level] of Object.entries(bumps)) {
		const kind = KINDS.get(level);
		const id = keys.get(key) ?? key;
		if (kind) {
			const units = byKind.get(kind) ?? [];
			byKind.set(kind, units.includes(id) ? units : [...units, id]);
		} else if (level !== "none") {
			ctx.log.warn(`${path}: "${key}" has unknown bump "${String(level)}"`);
		}
	}

	const [subject = "", ...rest] = match[2]?.trim().split("\n") ?? [];
	const body = rest.join("\n").trim();

	return [...byKind].map(([kind, units]) => ({
		...kind,
		units,
		subject: subject.trim(),
		...(body === "" ? {} : { body }),
		files: [path],
	}));
};

/**
 * Changes from `.changeset/*.md` files touched in the range; each names its
 * units explicitly and consumes its file.
 */
export const changesetsPlugin = definePlugin({
	apiVersion: 1,
	name: "changesets",
	options: z.strictObject({}),
	intent: [
		{
			name: "changesets",
			collect: (ctx, { commits, units }) => {
				const touched = new Set(commits.flatMap((c) => c.files));
				const keys = unitKeys(units);

				return ctx.fs
					.glob([".changeset/*.md"])
					.filter((path) => touched.has(path))
					.flatMap((path) => changesOf(ctx, path, keys));
			},
		},
	],
});
