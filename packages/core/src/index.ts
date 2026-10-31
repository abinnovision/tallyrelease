/** @deprecated Unused, will be removed in 1.0. */
export const version = "0.0.0";

export type {
	AffectedDoc,
	AffectedOptions,
	AffectedReason,
	AffectedUnit,
	BaseSource,
} from "./model/affected-types.js";
export type {
	CodeDoc,
	CodeOf,
	CodeRegistry,
	ErrorCode,
	WarningCode,
} from "./codes.js";
export type { ParsedCommit } from "./conventional.js";
export type {
	ExplainedChange,
	ExplainOptions,
	ReleaseAsFooter,
	UnitExplanation,
} from "./explain.js";
export type { BranchRule, Line as PlanLine } from "./model/branch-types.js";
export type {
	GroupPlan,
	Plan,
	PlanChange,
	PlanOptions,
	ReleasedUnit,
	UnitPlan,
} from "./model/plan-types.js";
export type {
	DepConfig,
	GroupConfig,
	ReleasePrMode,
	TallyConfig,
	UnitOverlay,
	VersionTemplate,
} from "./config.js";
export type { Warning } from "./errors.js";
export type { Graph } from "./graph.js";
export type { Group } from "./groups.js";
export type {
	BumpLevel,
	Change,
	Ctx,
	Edge,
	EdgeDraft,
	GitReader,
	IntentSource,
	MaybePromise,
	Plugin,
	PreCtx,
	Propagate,
	RawCommit,
	ReadonlyFs,
	ReleaseAsValue,
	TagRef,
	Unit,
	UnitDraft,
	VersionFile,
	VersionMode,
	VersionScheme,
	VersionSource,
	WriteCtx,
} from "./plugin.js";
export type { Marker, MarkerRelease } from "./marker.js";
export type { ReleaseItem } from "./release-items.js";
export type { ReleaseSettings } from "./release-settings.js";
export type { SemVer } from "./semver.js";
export type { IntentEntry, Workspace, WorkspaceInput } from "./workspace.js";

export { computeAffected } from "./affected.js";
export { maintenanceCut } from "./branches.js";
export { releaseNotes } from "./changelog.js";
export { coreCodes, defineCodes } from "./codes.js";
export { CONFIG_FILE } from "./config.js";
export { parseCommit } from "./conventional.js";
export { TallyError } from "./errors.js";
export { explainUnit } from "./explain.js";
export { definePlugin, defaultUnitId, PLUGIN_API_VERSION } from "./plugin.js";
export { computePlan } from "./plan.js";
export { decodeMarker, encodeMarker } from "./marker.js";
export { planEquals, releaseEntries, releaseItems } from "./release-items.js";
export { releasedFromTags, withReleased } from "./released.js";
export { semver } from "./semver.js";
export { validateRelease, validateTags } from "./validate.js";
export { releaseFiles, versionFileClaims } from "./version-files.js";
export { loadWorkspace } from "./workspace.js";
