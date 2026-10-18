// Renders docs/configuration.md from the cli config JSON schema.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { cell, code } from "../markdown.ts";

import type { DocTarget } from "../runner.ts";

interface SchemaNode {
	type?: string;
	description?: string;
	enum?: unknown[];
	anyOf?: SchemaNode[];
	items?: SchemaNode;
	properties?: Record<string, SchemaNode>;
	required?: string[];
	additionalProperties?: SchemaNode | boolean;
}

type ObjectNode = SchemaNode & { properties: Record<string, SchemaNode> };
type MapNode = SchemaNode & { additionalProperties: SchemaNode };

interface Row {
	path: string;
	node: SchemaNode;
	required: boolean;
}

/** Object variants of a node, merged across anyOf branches. */
const variants = (node: SchemaNode): ObjectNode[] =>
	(node.anyOf ?? [node]).filter((n): n is ObjectNode => !!n.properties);

/** Object keyed by user-chosen names with a described value. */
const isMap = (node: SchemaNode): node is MapNode =>
	node.type === "object" &&
	!node.properties &&
	typeof node.additionalProperties === "object" &&
	Object.keys(node.additionalProperties).length > 0;

const typeOf = (node: SchemaNode): string => {
	if (node.enum) {
		return node.enum.map((v) => code(JSON.stringify(v))).join(" or ");
	}

	if (node.anyOf) {
		return [...new Set(node.anyOf.map(typeOf))].join(" or ");
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
const rows = (node: SchemaNode, path: string): Row[] => {
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

const section = (key: string, node: SchemaNode): string => {
	const lines = [`## ${code(key)}`, "", node.description ?? "", ""];
	lines.push(`Type: ${typeOf(node)}.`, "");
	const nested = rows(node, key);
	if (nested.length) {
		lines.push(
			"| Key | Type | Required | Description |",
			"| --- | --- | --- | --- |",
		);
		for (const r of nested) {
			lines.push(
				`| ${code(r.path)} | ${cell(typeOf(r.node))} | ${r.required ? "yes" : "no"} | ${cell(r.node.description ?? "")} |`,
			);
		}

		lines.push("");
	}

	return lines.join("\n");
};

export const configuration: DocTarget = {
	name: "configuration",
	path: "docs/configuration.md",
	render: () => {
		const schema = JSON.parse(
			readFileSync(
				fileURLToPath(
					import.meta.resolve("@tallyrelease/cli/tallyrelease.schema.json"),
				),
				"utf8",
			),
		) as SchemaNode;

		return [
			"# Configuration reference",
			"",
			"tallyrelease reads `tallyrelease.yaml` at the repository root. The JSON schema is exported as `@tallyrelease/cli/tallyrelease.schema.json`. `<name>` stands for a key you choose and `[]` for each list item.",
			"",
			...Object.entries(schema.properties ?? {})
				.filter(([key]) => key !== "$schema")
				.map(([key, node]) => section(key, node)),
		].join("\n");
	},
};
