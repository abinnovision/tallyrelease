// Renders docs/cli.md from the commander program of the cli.
import { createProgram } from "@tallyrelease/cli";

import { cell, code } from "../markdown.ts";

import type { DocTarget } from "../runner.ts";

type Program = ReturnType<typeof createProgram>;

const or = (items: string[]): string =>
	items.length > 1
		? `${items.slice(0, -1).join(", ")} or ${items.at(-1) ?? ""}`
		: items.join("");

const flags = (cmd: Program): string[] => [
	"| Flag | Description | Default |",
	"| --- | --- | --- |",
	...cmd
		.createHelp()
		.visibleOptions(cmd)
		// `--help` is listed under the global flags only.
		.filter((o) => !cmd.parent || o.long !== "--help")
		.map((o) => {
			const choices = o.argChoices
				? ` (one of ${or(o.argChoices.map(code))})`
				: "";
			const defaultValue =
				o.defaultValue === undefined ? "" : code(String(o.defaultValue));

			// Escaped so `<name>` in descriptions is not read as HTML.
			const description = o.description.replaceAll("<", "\\<");

			return `| ${code(o.flags)} | ${cell(description + choices)} | ${defaultValue} |`;
		}),
	"",
];

const command = (cmd: Program): string[] => {
	const args = cmd.registeredArguments;
	const description = cmd.description();
	const usage = [
		"tallyrelease",
		cmd.name(),
		...args.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`)),
		"[flags]",
	].join(" ");

	return [
		`## tallyrelease ${cmd.name()}`,
		"",
		`${description.charAt(0).toUpperCase()}${description.slice(1)}.`,
		"",
		"```sh",
		usage,
		"```",
		"",
		...(args.length
			? [
					"| Argument | Description |",
					"| --- | --- |",
					...args.map((a) => `| ${code(a.name())} | ${cell(a.description)} |`),
					"",
				]
			: []),
		...flags(cmd),
	];
};

const tail = `## Flag rules

- \`--json\` and \`--format\` cannot be combined; the command exits with 2.
- \`plan --summary\` with JSON output (\`--json\` or \`--format json\`) needs \`GITHUB_STEP_SUMMARY\`, since both would use stdout; otherwise the command exits with 2.
- \`affected --tag\` is repeatable and keeps units with at least one of the given tags.
- \`--allow-local-plugins\` (or \`TALLYRELEASE_ALLOW_LOCAL_PLUGINS=true\`) only matters for \`pr\`, \`release\`, \`run\` and \`version\`. These commands never load local plugins on a pull request head.

## Exit codes

| Code | Meaning |
| --- | --- |
| \`0\` | Success, also for \`--help\` and \`--version\`. |
| \`1\` | Error, printed as \`error[E_*]: message\` on stderr. |
| \`2\` | Usage error, such as an unknown flag or a missing argument. |

## Scripting

Use \`--format tsv\` or \`--json\` in scripts. The text layout may change between versions; changes to the \`json\`, \`tsv\` and \`mermaid\` formats are listed in the changelog. The JSON documents of \`affected\`, \`plan\` and \`explain\` have schemas exported as \`@tallyrelease/cli/affected.schema.json\`, \`@tallyrelease/cli/plan.schema.json\` and \`@tallyrelease/cli/explain.schema.json\`.
`;

export const cli: DocTarget = {
	name: "cli",
	path: "docs/cli.md",
	render: () => {
		const program = createProgram({
			env: {},
			cwd: "/",
			stdout: { write() {} },
			stderr: { write() {} },
		});

		return [
			"# Command reference",
			"",
			"Run `tallyrelease <command> [flags]`; `--help` on any command prints its flags. Error codes are listed in [errors.md](errors.md) and config keys in [configuration.md](configuration.md).",
			"",
			"## Global flags",
			"",
			...flags(program),
			...program.commands.flatMap(command),
			tail,
		].join("\n");
	},
};
