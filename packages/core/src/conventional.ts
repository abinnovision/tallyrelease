import type { Change, IntentSource, ReleaseAsValue } from "./plugin.js";

const HEADER =
	/^(?<type>[A-Za-z][\w-]*)(?:\((?<scope>[^()]*)\))?(?<bang>!)?: (?<subject>.+)$/u;
const PR = /\s*\(#(?<pr>\d+)\)$/u;
const FOOTER =
	/^(?<key>BREAKING[ -]CHANGE|[A-Za-z][A-Za-z0-9-]*)(?:: | #)(?<value>.*)$/u;
const QUALIFIED = /^(?<unit>[A-Za-z0-9._-]+)@(?<version>.+)$/u;

const BREAKING = new Set(["BREAKING CHANGE", "BREAKING-CHANGE"]);

const releaseAs = (value: string): ReleaseAsValue => {
	const version = value.split("\n")[0]?.trim() ?? "";
	const match = QUALIFIED.exec(version)?.groups;

	return match?.["unit"] !== undefined && match["version"] !== undefined
		? { unit: match["unit"], version: match["version"] }
		: { version };
};

const withPr = (text: string): { subject: string; pr: number | undefined } => {
	const pr = PR.exec(text)?.groups?.["pr"];

	return pr === undefined
		? { subject: text, pr: undefined }
		: { subject: text.replace(PR, ""), pr: Number(pr) };
};

export interface ParsedCommit {
	/** Empty for a non-conventional header. */
	type: string;
	scope: string | undefined;
	breaking: boolean;
	subject: string;
	body: string | undefined;
	pr: number | undefined;
	/** Last breaking-change footer value of either spelling, as in release-please. */
	notes: string | undefined;
	/** Lowercased footer key to values in message order. */
	footers: Record<string, string[]>;
}

/**
 * Parses a commit message per Conventional Commits. The footer block starts at
 * the first paragraph whose first line is `token: value` or `token #value`; a
 * footer value runs until the next such line.
 */
export const parseCommit = (message: string): ParsedCommit => {
	const [first = "", ...rest] = message.replace(/\r\n?/gu, "\n").split("\n");
	const header = first.trim();
	let start = rest.findIndex(
		(line, i) => FOOTER.test(line) && (i === 0 || rest[i - 1]?.trim() === ""),
	);
	start = start === -1 ? rest.length : start;

	const footers = new Map<string, string[][]>();
	let current: string[] | undefined;
	let note: string[] | undefined;
	let breaking = false;
	for (const line of rest.slice(start)) {
		const match = FOOTER.exec(line)?.groups;
		if (match?.["key"] === undefined) {
			current?.push(line);
			continue;
		}

		breaking ||= BREAKING.has(match["key"]);
		const key = match["key"].toLowerCase();
		current = [(match["value"] ?? "").trim()];
		footers.set(key, [...(footers.get(key) ?? []), current]);
		if (BREAKING.has(key.toUpperCase())) {
			note = current;
		}
	}

	const body =
		rest
			.slice(0, start)
			.join("\n")
			.replace(/^(?:[ \t]*\n)+/u, "")
			.trimEnd() || undefined;
	const common = {
		body,
		notes: note?.join("\n").trimEnd(),
		footers: Object.fromEntries(
			[...footers].map(([key, values]) => [
				key,
				values.map((lines) => lines.join("\n").trimEnd()),
			]),
		),
	};
	const parts = HEADER.exec(header)?.groups;
	if (parts?.["type"] === undefined) {
		return {
			type: "",
			scope: undefined,
			breaking,
			...withPr(header),
			...common,
		};
	}

	return {
		type: parts["type"],
		scope: parts["scope"] === "" ? undefined : parts["scope"],
		breaking: breaking || parts["bang"] !== undefined,
		...withPr(parts["subject"] ?? ""),
		...common,
	};
};

/** Maps each commit to exactly one commit-derived Change. */
export const conventionalCommits: IntentSource = {
	name: "conventional-commits",
	collect: (_ctx, { commits }) =>
		commits.map((commit): Change => {
			const parsed = parseCommit(commit.message);
			const values = parsed.footers["release-as"] ?? [];

			return {
				sha: commit.sha,
				type: parsed.type,
				breaking: parsed.breaking,
				...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
				subject: parsed.subject,
				...(parsed.body === undefined ? {} : { body: parsed.body }),
				...(parsed.notes === undefined ? {} : { notes: parsed.notes }),
				...(parsed.pr === undefined ? {} : { pr: parsed.pr }),
				...(values.length === 0 ? {} : { releaseAs: values.map(releaseAs) }),
			};
		}),
};
