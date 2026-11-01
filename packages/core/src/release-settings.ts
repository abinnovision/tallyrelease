import { normalizeRoot } from "./discover.js";

import type {
	ReleasePrMode,
	TallyConfig,
	UnitOverlay,
	VersionTemplate,
} from "./config.js";
import type { BranchRule } from "./model/branch-types.js";
import type { BumpLevel, Unit } from "./plugin.js";

const DEFAULT_TYPES: Readonly<Record<string, BumpLevel>> = {
	feat: "minor",
	fix: "patch",
	perf: "patch",
	revert: "patch",
};

/** Unit overlays of the config with the id of the unit at their root. */
const unitOverlays = (
	config: TallyConfig,
	units: readonly Unit[],
): (readonly [string, UnitOverlay])[] =>
	Object.entries(config.units ?? {}).flatMap(([root, overlay]) => {
		const unit = units.find((u) => u.root === normalizeRoot(root));

		return unit ? [[unit.id, overlay] as const] : [];
	});

/** Release config with defaults applied. */
export interface ReleaseSettings {
	/** Commit type to level. */
	readonly bumps: ReadonlyMap<string, BumpLevel>;
	/** Levels used while `core(from).major == 0`. */
	readonly preMajor: { readonly breaking: BumpLevel; readonly feat: BumpLevel };
	/** Level cap of absorbed changes with a bump. */
	readonly absorbed: "patch" | "minor";
	/** In config order. */
	readonly branches: readonly BranchRule[];
	readonly releasePr: {
		readonly default: ReleasePrMode;
		/** Set by unit overlays, by unit id. */
		readonly units: ReadonlyMap<string, ReleasePrMode>;
		/** Set by groups, by group name. */
		readonly groups: ReadonlyMap<string, ReleasePrMode>;
	};
	/** Floating tag formats. */
	readonly floating: readonly string[];
	/** Version file templates by unit id. */
	readonly templates: ReadonlyMap<string, readonly VersionTemplate[]>;
}

/** Applies the defaults to `bumps` and `branches`. */
export const releaseSettings = (
	config: TallyConfig,
	units: readonly Unit[],
): ReleaseSettings => {
	const overlays = unitOverlays(config, units);

	return {
		bumps: new Map(
			Object.entries({ ...DEFAULT_TYPES, ...config.bumps?.types }),
		),
		absorbed: config.bumps?.absorbed ?? "patch",
		preMajor: {
			breaking: config.bumps?.preMajor?.breaking ?? "minor",
			feat: config.bumps?.preMajor?.feat ?? "minor",
		},
		branches: (config.branches ?? []).map((b) => ({
			name: b.name,
			line: b.line,
			// eslint-disable-next-line @typescript-eslint/no-deprecated -- normalizes the alias
			channel: b.channel ?? null,
			build: b.channels?.build ?? null,
			cut: b.channels?.cut ?? null,
			unit: b.unit ?? null,
			group: b.group ?? null,
		})),
		releasePr: {
			default: config.defaults?.releasePr ?? "shared",
			units: new Map(
				overlays.flatMap(([id, overlay]) =>
					overlay.releasePr ? [[id, overlay.releasePr] as const] : [],
				),
			),
			groups: new Map(
				Object.entries(config.groups ?? {}).flatMap(([name, group]) =>
					group.releasePr ? [[name, group.releasePr] as const] : [],
				),
			),
		},
		floating: config.tags?.floating ?? [],
		templates: new Map(
			overlays.flatMap(([id, overlay]) =>
				overlay.versionFiles ? [[id, overlay.versionFiles] as const] : [],
			),
		),
	};
};
