// Helpers for reading and walking JSON schemas.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { code } from "./markdown.ts";

export interface SchemaNode {
	type?: string | string[];
	description?: string;
	enum?: unknown[];
	anyOf?: SchemaNode[];
	items?: SchemaNode;
	properties?: Record<string, SchemaNode>;
	required?: string[];
	additionalProperties?: SchemaNode | boolean;
}

type ObjectNode = SchemaNode & {
	properties: Record<string, SchemaNode>;
};
type MapNode = SchemaNode & { additionalProperties: SchemaNode };

interface Row {
	path: string;
	node: SchemaNode;
	required: boolean;
}

/** Parses the JSON schema file a package specifier resolves to. */
export const readSchema = (specifier: string): SchemaNode =>
	JSON.parse(
		readFileSync(fileURLToPath(import.meta.resolve(specifier)), "utf8"),
	) as SchemaNode;

/** Object variants of a node, merged across anyOf branches. */
const variants = (node: SchemaNode): ObjectNode[] =>
	(node.anyOf ?? [node]).filter((n): n is ObjectNode => !!n.properties);

/** Object keyed by user-chosen names with a described value. */
const isMap = (node: SchemaNode): node is MapNode =>
	node.type === "object" &&
	!node.properties &&
	typeof node.additionalProperties === "object" &&
	Object.keys(node.additionalProperties).length > 0;

export const typeOf = (node: SchemaNode): string => {
	if (node.enum) {
		return node.enum.map((v) => code(JSON.stringify(v))).join(" or ");
	}

	if (node.anyOf) {
		return [...new Set(node.anyOf.map(typeOf))].join(" or ");
	}

	if (Array.isArray(node.type)) {
		return node.type.join(" or ");
	}

	if (node.type === "array") {
		return `list of ${typeOf(node.items ?? {})}`;
	}

	if (isMap(node)) {
		return `map of ${typeOf(node.additionalProperties)}`;
	}

	return node.type ?? "any";
};

/** Rows for the keys below a node, one per property, depth first. */
export const rows = (node: SchemaNode, path: string): Row[] => {
	const children: Row[] = [];
	const objects = variants(node);
	const required = objects.length
		? objects
				.map((o) => new Set(o.required ?? []))
				.reduce((a, b) => new Set([...a].filter((k) => b.has(k))))
		: new Set<string>();
	const seen = new Set<string>();
	for (const object of objects) {
		for (const [key, child] of Object.entries(object.properties)) {
			if (seen.has(key)) {
				continue;
			}

			seen.add(key);
			const row = {
				path: `${path}.${key}`,
				node: child,
				required: required.has(key),
			};
			children.push(row, ...rows(child, row.path));
		}
	}

	if (isMap(node)) {
		children.push(...rows(node.additionalProperties, `${path}.<name>`));
	}

	if (node.type === "array" && node.items) {
		children.push(...rows(node.items, `${path}[]`));
	}

	return children;
};
