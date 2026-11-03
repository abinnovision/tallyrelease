// Renders a commit history with lanes, tags and versions as an SVG.
/* eslint-disable @typescript-eslint/restrict-template-expressions -- SVG markup interpolates numeric coordinates. */

export interface Commit {
	lane: string;
	subject: string;
	kind?: "merge";
	tags?: string[];
	versions?: string[];
	floating?: string[];
	note?: string;
	error?: string;
	/** Lane that starts below this commit. */
	branchFrom?: string;
	/** Lane merged into this commit; its line ends at its last earlier commit. */
	mergeFrom?: string;
	/** Neutral labels such as `merge base` or `HEAD`. */
	markers?: string[];
}

export interface Step {
	name: string;
	/** Number of leading commits to show. */
	commits: number;
	/** Lanes to show; defaults to all. */
	lanes?: string[];
}

export interface History {
	lanes: string[];
	commits: Commit[];
	steps?: Step[];
}

export type Theme = "light" | "dark";

// Same palette as docs/assets/how-it-works-*.svg.
const palettes = {
	light: {
		page: "#ffffff",
		surface: "#ffffff",
		border: "#d0d7de",
		text: "#1f2328",
		muted: "#59636e",
		accent: "#0f9b8e",
		tint: "#e8f7f5",
		red: "#cf222e",
		redTint: "#ffebe9",
	},
	dark: {
		page: "#0d1117",
		surface: "#161b22",
		border: "#30363d",
		text: "#e6edf3",
		muted: "#9198a1",
		accent: "#2dd4bf",
		tint: "#0f2e2c",
		red: "#f85149",
		redTint: "#2d1517",
	},
};

const W = 880;
const HEAD = 44;
const ROW = 34;
const LANE0 = 30;
const LANE_GAP = 74;
// Approximate advance of an 11px monospace glyph.
const MONO = 6.6;

const esc = (s: string): string =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
const rowY = (i: number): number => HEAD + ROW * i + ROW / 2;
const pillW = (s: string): number => Math.round(s.length * MONO + 16);

// Keeps the first `commits` commits and drops hidden lanes with their fork connectors.
export const historyStep = (history: History, step: Step): History => {
	const lanes = step.lanes ?? history.lanes;

	return {
		lanes: history.lanes.filter((lane) => lanes.includes(lane)),
		commits: history.commits
			.slice(0, step.commits)
			.filter((c) => lanes.includes(c.lane))
			.map(({ branchFrom, ...c }) =>
				branchFrom && lanes.includes(branchFrom) ? { ...c, branchFrom } : c,
			),
	};
};

const describe = ({ lanes, commits }: History): string => {
	const rows = commits.map((c, i) => {
		const parts = [
			c.tags && `tags ${c.tags.join(", ")}`,
			c.versions && `plans ${c.versions.join(", ")}`,
			c.floating && `moves ${c.floating.join(", ")}`,
			c.branchFrom && `starts ${c.branchFrom}`,
			c.mergeFrom && `merges ${c.mergeFrom}`,
			c.markers && `marked ${c.markers.join(", ")}`,
			c.error && `fails with ${c.error}`,
			c.note,
		].filter(Boolean);

		return `${i + 1}. On ${c.lane}, ${c.subject}${parts.length ? `: ${parts.join("; ")}` : ""}.`;
	});

	return `Release history on ${lanes.join(" and ")}. ${rows.join(" ")}`;
};

export const renderHistory = (history: History, theme: Theme): string => {
	const { lanes, commits } = history;
	const t = palettes[theme];
	// Widens the lane gap so adjacent lane labels do not touch.
	const gap = Math.max(
		LANE_GAP,
		...lanes.slice(1).map((l, i) => (pillW(lanes[i] ?? "") + pillW(l)) / 2 + 8),
	);
	const laneX = (lane: string): number => LANE0 + lanes.indexOf(lane) * gap;
	const subjectX = LANE0 + (lanes.length - 1) * gap + 60;
	const resultX = subjectX + 220;
	// A fork on the last row needs room for its connector.
	const height =
		HEAD + commits.length * ROW + (commits.at(-1)?.branchFrom ? 28 : 6);
	const out: string[] = [];

	const pill = (
		x: number,
		y: number,
		style: {
			text: string;
			stroke: string;
			fill?: string;
			color: string;
			dash?: boolean;
		},
	): number => {
		const { text } = style;
		const w = pillW(text);
		const dash = style.dash ? ` stroke-dasharray="3 2.5"` : "";
		out.push(
			`<rect x="${x}" y="${y - 9}" width="${w}" height="18" rx="9" fill="${style.fill ?? "none"}" stroke="${style.stroke}" stroke-width="1.5"${dash}/>`,
			`<text class="mono" x="${x + w / 2}" y="${y + 4}" text-anchor="middle" fill="${style.color}">${esc(text)}</text>`,
		);

		return x + w + 6;
	};

	// Lane labels and lines.
	for (const lane of lanes) {
		const x = laneX(lane);
		const w = pillW(lane);
		out.push(
			`<rect x="${x - w / 2}" y="6" width="${w}" height="20" rx="10" fill="${t.surface}" stroke="${t.border}" stroke-width="1.5"/>`,
			`<text class="mono" x="${x}" y="20" text-anchor="middle" fill="${t.muted}">${esc(lane)}</text>`,
		);
		const rows = commits.flatMap((c, i) => (c.lane === lane ? [i] : []));
		const first = rows[0];
		const last = rows.at(-1);
		if (first === undefined || last === undefined) {
			continue;
		}

		const from = commits.findIndex((c) => c.branchFrom === lane);
		const y0 = from >= 0 ? rowY(from) + 26 : rowY(first);
		out.push(
			`<path d="M${x} ${y0}V${rowY(last)}" stroke="${t.border}" stroke-width="1.5" fill="none"/>`,
		);
	}

	// Branch connectors.
	commits.forEach((c, i) => {
		if (!c.branchFrom) {
			return;
		}

		const x1 = laneX(c.lane);
		const x2 = laneX(c.branchFrom);
		const y = rowY(i);
		out.push(
			`<path d="M${x1} ${y}C${x1} ${y + 16} ${x2} ${y + 10} ${x2} ${y + 26}" stroke="${t.border}" stroke-width="1.5" fill="none"/>`,
		);
	});

	// Merge connectors.
	commits.forEach((c, i) => {
		if (!c.mergeFrom) {
			return;
		}

		const prev = commits.findLastIndex(
			(p, j) => j < i && p.lane === c.mergeFrom,
		);
		if (prev < 0) {
			return;
		}

		const x1 = laneX(c.mergeFrom);
		const x2 = laneX(c.lane);
		const y1 = rowY(prev);
		const y2 = rowY(i);
		const mid = (y1 + y2) / 2;
		out.push(
			`<path d="M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}" stroke="${t.border}" stroke-width="1.5" fill="none"/>`,
		);
	});

	// Commit rows.
	commits.forEach((c, i) => {
		const x = laneX(c.lane);
		const y = rowY(i);
		out.push(
			c.kind === "merge"
				? `<circle cx="${x}" cy="${y}" r="4" fill="${t.page}" stroke="${t.accent}" stroke-width="1.5"/>`
				: `<circle cx="${x}" cy="${y}" r="4" fill="${c.error ? t.red : t.text}"/>`,
			`<text class="mono sub" x="${subjectX}" y="${y + 4}" fill="${c.subject.startsWith("chore(release)") ? t.muted : t.text}">${esc(c.subject)}</text>`,
		);

		let cx = resultX;
		for (const s of c.tags ?? []) {
			cx = pill(cx, y, {
				text: s,
				stroke: t.accent,
				fill: t.tint,
				color: t.accent,
			});
		}

		for (const s of c.versions ?? []) {
			out.push(
				`<text class="mono" x="${cx}" y="${y + 4}" fill="${t.text}">${esc(s)}</text>`,
			);
			cx += Math.round(s.length * MONO) + 12;
		}

		for (const s of c.floating ?? []) {
			cx = pill(cx, y, {
				text: s,
				stroke: t.accent,
				color: t.accent,
				dash: true,
			});
		}

		if (c.error) {
			cx = pill(cx, y, {
				text: c.error,
				stroke: t.red,
				fill: t.redTint,
				color: t.red,
			});
		}

		for (const s of c.markers ?? []) {
			cx = pill(cx, y, { text: s, stroke: t.border, color: t.muted });
		}

		if (c.note) {
			out.push(
				`<text class="sans" x="${cx + 4}" y="${y + 4}" fill="${t.muted}">${esc(c.note)}</text>`,
			);
		}
	});

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" role="img" aria-label="${esc(describe(history))}">
  <title>Release history</title>
  <defs>
    <style>
      .sans{font-family:ui-sans-serif,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:11px}
      .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;white-space:pre}
      .sub{font-size:12px}
    </style>
  </defs>
  ${out.join("\n  ")}
</svg>
`;
};
