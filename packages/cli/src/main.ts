import { CONFIG_FILE, TallyError } from "@tallyrelease/core";
import { Command, CommanderError, Option } from "commander";
import { inspect } from "node:util";

import { affected } from "./commands/affected.js";
import { check } from "./commands/check.js";
import { explain } from "./commands/explain.js";
import { graph } from "./commands/graph.js";
import { plan } from "./commands/plan.js";
import { releasePrs } from "./commands/pr.js";
import { reconcile } from "./commands/release.js";
import { run } from "./commands/run.js";
import { shadow } from "./commands/shadow.js";
import { applyVersions } from "./commands/version.js";
import { painter } from "./output/paint.js";
import { createSession } from "./session.js";
import { version } from "./version.js";

import type { PlanFlags } from "./app/setup.js";
import type { cliCodes } from "./codes.js";
import type { AffectedFlags } from "./commands/affected.js";
import type { CheckFlags } from "./commands/check.js";
import type { ExplainFlags } from "./commands/explain.js";
import type { GraphFlags } from "./commands/graph.js";
import type { PrFlags } from "./commands/pr.js";
import type { ReleaseFlags } from "./commands/release.js";
import type { RunFlags } from "./commands/run.js";
import type { ShadowFlags } from "./commands/shadow.js";
import type { VersionFlags } from "./commands/version.js";
import type { Deps, GlobalOptions } from "./session.js";
import type { CodeOf, ErrorCode } from "@tallyrelease/core";

const internal = "E_INTERNAL" satisfies ErrorCode<CodeOf<typeof cliCodes>>;

/** Runs the cli; returns the exit code (0 ok, 1 error, 2 usage). */
export const main = async (
	argv: readonly string[],
	deps: Deps,
): Promise<number> => {
	const program = new Command("tallyrelease")
		.description("Affected build units for monorepos and single repos")
		.version(version)
		.option("--cwd <dir>", "repository root")
		.option("--config <file>", "config file", CONFIG_FILE)
		.option("--token <token>", "forge token (default: GITHUB_TOKEN)")
		.option(
			"--remote <name>",
			"git remote to push to and read the repository from",
			"origin",
		)
		.option("--verbose", "print debug output")
		.option(
			"--allow-local-plugins",
			"let pr, release, run and version load plugins.<name>.path",
		)
		.exitOverride()
		.configureOutput({
			writeOut: (s) => deps.stdout.write(s),
			writeErr: (s) => deps.stderr.write(s),
		});
	const session = (privileged = false) =>
		createSession(deps, { ...program.opts<GlobalOptions>(), privileged });

	program
		.command("check")
		.description("validate config, plugins, units, graph and the plan")
		.option("--branch <name>", "plan for this branch (default: current)")
		.option(
			"--head <ref>",
			"check this commit with the current config; pass --branch for its branch rule",
		)
		.action(async (flags: CheckFlags) => {
			await check(session(), flags);
		});
	program
		.command("graph")
		.description("print units and edges")
		.option("--json", "print JSON (same as --format json)")
		.addOption(
			new Option("--format <format>", "output format").choices([
				"text",
				"json",
				"mermaid",
			]),
		)
		.action(async (flags: GraphFlags, cmd: Command) => {
			if (flags.json && flags.format !== undefined) {
				cmd.error("--json and --format cannot be combined", { exitCode: 2 });
			}

			await graph(session(), flags);
		});
	program
		.command("affected")
		.description("compute the build set")
		.option("--base <ref>", "diff against this ref")
		.option("--json", "print the affected document (same as --format json)")
		.addOption(
			new Option("--format <format>", "output format").choices([
				"text",
				"json",
				"tsv",
			]),
		)
		.option("--out <file>", "write the affected document to a file")
		.option("--github-output", "append outputs to $GITHUB_OUTPUT")
		.option(
			"--tag <tag>",
			"keep units with this tag (repeatable)",
			(tag: string, prior?: string[]) => [...(prior ?? []), tag],
		)
		.action(async (flags: AffectedFlags, cmd: Command) => {
			if (flags.json && flags.format !== undefined) {
				cmd.error("--json and --format cannot be combined", { exitCode: 2 });
			}

			await affected(session(), flags);
		});
	program
		.command("plan")
		.description("compute the release plan (read-only)")
		.option("--branch <name>", "plan for this branch (default: current)")
		.option("--base <ref>", "diff against this ref")
		.option(
			"--head <ref>",
			"plan this commit with the current config; pass --branch for its branch rule",
		)
		.option("--all", "also list released units outside the build set")
		.option("--json", "print the plan (same as --format json)")
		.addOption(
			new Option("--format <format>", "output format").choices([
				"text",
				"json",
			]),
		)
		.option("--out <file>", "write the plan to a file")
		.option("--github-output", "append outputs to $GITHUB_OUTPUT")
		.option(
			"--summary",
			"write markdown to $GITHUB_STEP_SUMMARY, else print it instead of the table",
		)
		.action(async (flags: PlanFlags, cmd: Command) => {
			if (flags.json && flags.format !== undefined) {
				cmd.error("--json and --format cannot be combined", { exitCode: 2 });
			}

			if (
				flags.summary &&
				(flags.json || flags.format === "json") &&
				!deps.env["GITHUB_STEP_SUMMARY"]
			) {
				cmd.error(
					"--summary needs GITHUB_STEP_SUMMARY when printing JSON; both use stdout",
					{ exitCode: 2 },
				);
			}

			await plan(session(), flags);
		});
	program
		.command("explain")
		.description("explain why a unit is affected and how it is versioned")
		.argument("<unit>", "unit id")
		.option("--branch <name>", "plan for this branch (default: current)")
		.option("--base <ref>", "diff against this ref")
		.action(async (unit: string, flags: ExplainFlags) => {
			await explain(session(), unit, flags);
		});
	program
		.command("shadow")
		.description("compare the plan with a release-please manifest change")
		.option(
			"--manifest <path>",
			"release-please manifest (default: .release-please-manifest.json)",
		)
		.option(
			"--rp-config <path>",
			"release-please config (default: release-please-config.json)",
		)
		.option("--head <ref>", "compare this merge instead of HEAD (replay)")
		.option("--branch <name>", "plan for this branch (default: current)")
		.option("--pin <spec>", "cli version recorded in the report")
		.option("--out <file>", "write the report to a file")
		.option(
			"--summary",
			"write markdown to $GITHUB_STEP_SUMMARY, else print it",
		)
		.option("--strict", "exit 1 on unlabelled mismatches")
		.action(async (flags: ShadowFlags) => {
			await shadow(session(), flags);
		});

	program
		.command("version")
		.description(
			"write version files and changelogs of pending releases to the working tree",
		)
		.option("--branch <name>", "plan for this branch (default: current)")
		.option("--dry-run", "print the files without writing them")
		.action(async (flags: VersionFlags) => {
			await applyVersions(session(true), flags);
		});
	program
		.command("pr")
		.description("create, update and close release PRs of pending releases")
		.option("--branch <name>", "plan for this branch (default: current)")
		.option("--dry-run", "print the actions without pushing or editing PRs")
		.action(async (flags: PrFlags) => {
			await releasePrs(session(true), flags);
		});
	program
		.command("release")
		.description("tag merged release PRs and create their GitHub releases")
		.option("--branch <name>", "plan for this branch (default: current)")
		.option("--dry-run", "print the actions without tagging or editing PRs")
		.action(async (flags: ReleaseFlags) => {
			await reconcile(session(true), flags, {
				command: "release",
				ready: async () => {
					await Promise.resolve();
				},
			});
		});
	program
		.command("run")
		.description(
			"tag merged release PRs, plan HEAD, update release PRs and write the plan",
		)
		.option("--branch <name>", "plan for this branch (default: current)")
		.option("--base <ref>", "diff against this ref")
		.option(
			"--dry-run",
			"print the actions without tagging, pushing or editing PRs",
		)
		.option("--out <file>", "write the plan to a file")
		.option("--github-output", "append outputs to $GITHUB_OUTPUT")
		.option(
			"--summary",
			"write markdown to $GITHUB_STEP_SUMMARY, else print it instead of the table",
		)
		.action(async (flags: RunFlags) => {
			await run(session(true), flags);
		});

	try {
		await program.parseAsync(argv, { from: "user" });

		return 0;
	} catch (error) {
		if (error instanceof CommanderError) {
			return error.exitCode === 0 ? 0 : 2;
		}

		const paint = painter(deps.stderr);
		if (error instanceof TallyError) {
			deps.stderr.write(
				`${paint("red", `error[${error.code}]`)}: ${error.message}\n`,
			);
		} else {
			deps.stderr.write(
				`${paint("red", `error[${internal}]`)}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			if (program.opts<GlobalOptions>().verbose) {
				deps.stderr.write(`${inspect(error)}\n`);
			}
		}

		return 1;
	}
};
