// Renders docs/configuration.md from the cli config JSON schema.
import { cell, code } from "../markdown.ts";
import { readSchema, rows, typeOf } from "../schema.ts";

import type { DocTarget } from "../runner.ts";
import type { SchemaNode } from "../schema.ts";

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
		const schema = readSchema("@tallyrelease/cli/tallyrelease.schema.json");

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
