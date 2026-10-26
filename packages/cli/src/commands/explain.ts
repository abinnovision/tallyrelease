import { explainUnit } from "@tallyrelease/core";

import { planOptions } from "../app/setup.js";
import { baseLine } from "../ci/base.js";
import { alignColumns } from "../output/columns.js";
import { painter } from "../output/paint.js";

import type { PlanFlags } from "../app/setup.js";
import type { Session } from "../session.js";
import type { UnitExplanation, UnitPlan } from "@tallyrelease/core";

const short = (sha: string | undefined) => sha?.slice(0, 7) ?? "-";

const releaseLine = (
	u: UnitPlan | null,
	released: boolean,
	{ group, nextSource }: Pick<UnitExplanation, "group" | "nextSource">,
): string => {
	if (!released) {
		return "not released";
	}

	if (u === null || u.next === null) {
		return "nothing pending";
	}

	const why =
		group !== null && nextSource !== "bump"
			? `group ${group.name}, ${nextSource ?? ""}`
			: group === null && u.releaseAs !== null
				? "release-as"
				: (u.bump ?? "");

	return `${u.from ?? "first release"} -> ${u.next} (${why})${u.version === null ? "" : `, version ${u.version}`}`;
};

export type ExplainFlags = Pick<PlanFlags, "branch" | "base">;

/** Explains why a unit is affected and how its version is computed. */
export const explain = async (
	session: Session,
	id: string,
	flags: ExplainFlags,
): Promise<void> => {
	const { opts, ref, base, warnings } = await planOptions(session, flags);
	const { explanation, unit } = await session.workspaceAt(
		ref,
		async (workspace, fs) => ({
			explanation: await explainUnit(workspace, session.git, {
				...opts,
				fs,
				unit: id,
			}),
			unit: workspace.units.find((u) => u.id === id),
		}),
	);
	session.warn([...explanation.warnings, ...warnings]);

	const paint = painter(session.stdout);
	const plan = explanation.unit;
	const affected = plan?.affected;
	const { group } = explanation;
	const lines = [
		`${paint("bold", id)}  ${paint("dim", `${unit?.root ?? ""}  ${unit?.plugin ?? ""}  ${unit?.scheme ?? ""}`)}`,
		baseLine(paint, base),
		"",
		`${paint("bold", "affected")}  ${
			affected
				? `${affected.reason === "group" ? `pulled by group ${group?.name ?? ""}` : affected.reason}${affected.via.length > 0 ? ` via ${affected.via.join(", ")}` : ""}`
				: "no"
		}`,
		...explanation.files.map((f) => `  ${f}`),
		...(group
			? [
					`${paint("bold", "group")}     ${group.name} ${paint("dim", `(${group.members.join(", ")})`)}`,
				]
			: []),
		`${paint("bold", "release")}   ${releaseLine(explanation.unit, unit?.version !== "none", explanation)}`,
	];
	if (plan?.baseTag) {
		lines.push(
			`  base tag ${plan.baseTag}${plan.lineBaseTag !== null && plan.lineBaseTag !== plan.baseTag ? `, line base tag ${plan.lineBaseTag}` : ""}`,
		);
	}

	if (explanation.introduced !== null) {
		lines.push(`  introduced ${short(explanation.introduced)}`);
	}

	if (explanation.changes.length > 0) {
		lines.push(
			"",
			paint("bold", `changes (${String(explanation.changes.length)})`),
		);
		const rows = alignColumns(
			explanation.changes.map((c) => [
				short(c.sha),
				`${c.type || "-"}${c.breaking ? "!" : ""}`,
				c.subject,
				c.via === undefined ? "" : `via ${c.via}`,
				c.releaseAs === undefined ? "" : `release-as ${c.releaseAs}`,
			]),
			{ indent: 2, styles: ["yellow", undefined, undefined, "dim", "cyan"] },
			paint,
		);
		explanation.changes.forEach((c, i) => {
			lines.push(
				rows[i] ?? "",
				...c.files.map((f) => `      ${paint("dim", f)}`),
			);
		});
	}

	if (explanation.propagatedFrom.length > 0) {
		lines.push(
			"",
			paint("bold", "propagated from"),
			...explanation.propagatedFrom.map(
				(p) =>
					`  ${p.id} ${paint("dim", p.pinned === null ? "(through unreleased units)" : p.pinned ? "(pinned)" : "(unpinned)")}`,
			),
		);
	}

	if (explanation.releaseAs.length > 0) {
		lines.push(
			"",
			paint("bold", "release-as footers"),
			...alignColumns(
				explanation.releaseAs.map((r) => [
					short(r.sha),
					r.qualified ? `${id}@${r.version}` : r.version,
					r.applied ? "applied" : "ignored",
				]),
				{ indent: 2, styles: ["yellow", undefined, "dim"] },
				paint,
			),
		);
	}

	session.stdout.write(`${lines.join("\n")}\n`);
};
