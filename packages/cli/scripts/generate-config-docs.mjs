// Renders docs/configuration.md from dist/tallyrelease.schema.json.
// With --check, fails when the committed file differs instead of writing it.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

const schema = JSON.parse(
	readFileSync(
		new URL("../dist/tallyrelease.schema.json", import.meta.url),
		"utf8",
	),
);
const target = fileURLToPath(
	new URL("../../../docs/configuration.md", import.meta.url),
);

const code = (s) => `\`${s}\``;
const cell = (s) => s.replaceAll("|", "\\|").replaceAll("\n", " ");

/** Object variants of a node, merged across anyOf branches. */
const variants = (node) => (node.anyOf ?? [node]).filter((n) => n.properties);

/** Object keyed by user-chosen names with a described value. */
const isMap = (node) =>
	node.type === "object" &&
	!node.properties &&
	Object.keys(node.additionalProperties ?? {}).length > 0;

const typeOf = (node) => {
	if (node.enum) {
		return node.enum.map((v) => code(JSON.stringify(v))).join(" or ");
	}
	if (node.anyOf) {
		return [...new Set(node.anyOf.map(typeOf))].join(" or ");
	}
	if (node.type === "array") {
		return `list of ${typeOf(node.items)}`;
	}
	if (isMap(node)) {
		return `map of ${typeOf(node.additionalProperties)}`;
	}

	return node.type ?? "any";
};

/** Rows for the keys below a node, one per property, depth first. */
const rows = (node, path) => {
	const children = [];
	const objects = variants(node);
	const required = objects.length
		? objects
				.map((o) => new Set(o.required ?? []))
				.reduce((a, b) => new Set([...a].filter((k) => b.has(k))))
		: new Set();
	const seen = new Set();
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

const section = (key, node) => {
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

const markdown = [
	"# Configuration reference",
	"",
	"<!-- Generated from the JSON schema by packages/cli/scripts/generate-config-docs.mjs. Run `yarn fix` to update. -->",
	"",
	"tallyrelease reads `tallyrelease.yaml` at the repository root. The JSON schema is exported as `@tallyrelease/cli/tallyrelease.schema.json`. `<name>` stands for a key you choose and `[]` for each list item.",
	"",
	...Object.entries(schema.properties)
		.filter(([key]) => key !== "$schema")
		.map(([key, node]) => section(key, node)),
].join("\n");

const formatted = await format(markdown, {
	...(await resolveConfig(target)),
	filepath: target,
});

if (process.argv.includes("--check")) {
	if (readFileSync(target, "utf8") !== formatted) {
		console.error(
			"docs/configuration.md is out of date with the config schema. Run `yarn fix`.",
		);
		process.exit(1);
	}
} else {
	writeFileSync(target, formatted);
}
