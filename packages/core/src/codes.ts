import { TallyError } from "./errors.js";

import type { Warning } from "./errors.js";

type Checked<R> = {
	[K in keyof R]: K extends `${"E" | "W"}_${string}` ? CodeDoc : never;
};

/** Documentation of one error or warning code. */
export interface CodeDoc {
	cause: string;
	fix: string;
}

export type ErrorCode<C extends string> = Extract<C, `E_${string}`>;
export type WarningCode<C extends string> = Extract<C, `W_${string}`>;

/** Documented codes and constructors typed to them. */
export interface CodeRegistry<C extends string> {
	readonly docs: Readonly<Record<C, CodeDoc>>;
	error: (
		code: ErrorCode<C>,
		message: string,
		details?: Record<string, unknown>,
	) => TallyError;
	warning: (
		code: WarningCode<C>,
		message: string,
		extra?: Pick<Warning, "plugin" | "unit">,
	) => Warning;
}

export type CodeOf<R> = R extends CodeRegistry<infer C> ? C : never;

/** Builds a registry from `E_*` and `W_*` codes and their documentation. */
export const defineCodes = <R extends Record<string, CodeDoc>>(
	docs: R & Checked<R>,
): CodeRegistry<keyof R & string> => ({
	docs,
	error: (code, message, details) => new TallyError(code, message, details),
	warning: (code, message, extra) => ({ code, message, ...extra }),
});

/**
 * Codes raised by core. Codes are only added, never removed or renamed.
 */
export const coreCodes = defineCodes({
	E_BRANCH_RULE: {
		cause:
			"An entry of `branches` is invalid. The `name` is empty, uses a token other than `{major}` or `{minor}`, repeats a token, uses `{minor}` without `{major}` or has an unbalanced brace. Or `unit` and `group` are both set, `unit` or `group` is set on a rule that is not a `maintenance` rule with `{major}`, or `unit` names a unit that is not released, is in a group or does not exist, or `group` names an unknown group.",
		fix: "Correct the rule named in the message. Use either `unit` (ungrouped released unit) or `group`, only on `line: maintenance` rules whose `name` contains `{major}`, and name a unit or group that exists in the config.",
	},
	E_CAP: {
		cause:
			"On a maintenance branch, a release item would leave the line of its current version, for example a breaking change or `Release-As` on a `release/1.x` branch. The message lists the offending commits.",
		fix: "Remove or reword the commits that exceed the limit, for example by moving them to the default branch, or use a `Release-As` value inside the line. If the branch should release a new major, use a `default` line rule with `channels.build` or `channels.cut` instead of a `maintenance` rule.",
	},
	E_CAP_BASE: {
		cause:
			"On a maintenance branch, the unit or group named by the rule (or the only release item) is at a version outside the line captured by the branch name. Typically the branch was cut from or merged with a commit that carries a newer tag.",
		fix: "Cut the branch from the last release of that line, or remove the newer commits from it. Set `unit` or `group` on the rule to name the item the line applies to.",
	},
	E_CHANNEL_DUPLICATE: {
		cause:
			"Two `branches` rules set the same channel, or one rule uses the same channel for `channels.build` and `channels.cut`. Build and cut channels (and the deprecated `channel`) share one namespace.",
		fix: "Give each `channels.build` and `channels.cut` a distinct value, or remove one of them.",
	},
	E_CHANNEL_INVALID: {
		cause:
			"A rule's `channels.build` or `channels.cut` (or the deprecated `channel`) is not a valid prerelease identifier: it must match `[0-9A-Za-z-]+`, contain a letter or dash, and use only `{major}` and `{minor}` tokens that the rule's `name` captures. The same code is raised when the channel does not form a valid prerelease for a version.",
		fix: "Use letters, digits and dashes only (for example `beta` or `rc-{major}`) and capture any token you use in the rule `name`.",
	},
	E_CHANNEL_WILDCARD: {
		cause:
			"A `branches` rule sets `channels.build` or `channels.cut` (or the deprecated `channel`) while its `name` contains `*`, so the channel would be ambiguous.",
		fix: "Remove the `*` from the rule `name`, or remove the channels from that rule.",
	},
	E_CONFIG: {
		cause:
			"The config file is not valid YAML, does not match the schema (unknown key, wrong type), or fails a semantic check: a unit sets `releasePr` while being in a group, a `tags.floating` format uses a token other than `{id}`, `{major}` or `{minor}`, a `versionFiles` entry has a bad `file` or `pattern`, or a `branches` rule sets both `channel` and `channels.build`.",
		fix: "Fix the key named in the message. Replace the deprecated `channel` with `channels.build`. A `versionFiles` `pattern` needs literal text and either `{version}` or the `{major}`, `{minor}`, `{patch}` tokens (not mixed), and `file` must be a repo-relative path without `..`. Set `releasePr` on the group instead of on its members.",
	},
	E_DUPLICATE_ROOT: {
		cause: "Two plugins discover a unit at the same root.",
		fix: "Disable one of the plugins under `plugins`, or move one of the packages so each root is discovered once.",
	},
	E_DUPLICATE_UNIT: {
		cause: "Two units resolve to the same id.",
		fix: "Give one of them a distinct `id` in `units.<root>`.",
	},
	E_EDGE_SELF: {
		cause:
			"A dependency edge points from a unit to itself. The message names the source, either a plugin or `config` (a `deps` entry).",
		fix: "Remove the edge, or correct `from` or `to` in the `deps` entry.",
	},
	E_EDGE_UNKNOWN_UNIT: {
		cause:
			"A dependency edge names a unit id that does not exist. The message names the source, either a plugin or `config` (a `deps` entry).",
		fix: "Correct `from` or `to` in the `deps` entry so both are existing unit ids.",
	},
	E_GIT_DATE: {
		cause: "A commit has a committer date that cannot be parsed.",
		fix: "Check the commit named in the message with `git log --format=%cI <sha>`. Rewrite the history if the date is corrupt, or plan with a `--base` after that commit.",
	},
	E_GROUP_NOT_RELEASED: {
		cause: "A group member is a unit that is not released.",
		fix: "Set `release: true` on the unit (or `defaults.release: true`), or remove it from the group's `units` or `tags` selection.",
	},
	E_GROUP_OVERLAP: {
		cause: "A unit is a member of two groups.",
		fix: "Adjust `groups.<name>.units` and `groups.<name>.tags` so every unit belongs to at most one group.",
	},
	E_GROUP_SCHEME: {
		cause: "Members of a group use different version schemes.",
		fix: "Set the same `scheme` on all members of the group, or split the group.",
	},
	E_GROUP_UNKNOWN_UNIT: {
		cause: "A group's `units` list names a unit id that does not exist.",
		fix: "Correct the id in `groups.<name>.units`.",
	},
	E_INITIAL_VERSION: {
		cause: "A unit's `initialVersion` is not a valid version for its scheme.",
		fix: "Set `initialVersion` (on the unit or in `defaults`) to a version its scheme accepts, for example `1.0.0` for `semver`.",
	},
	E_PLUGIN_API: {
		cause:
			"A plugin uses an API version that this tallyrelease does not support.",
		fix: "Use a plugin built for this version of tallyrelease, or upgrade or downgrade the CLI to match the plugin.",
	},
	E_PLUGIN_HOOK: {
		cause:
			"A plugin hook (such as `discover`, `edges`, `intent` or `write`) threw an error. The message names the plugin, the hook and the reason.",
		fix: "Fix the cause given in the message, usually a malformed manifest or version file in the repository, or the plugin options in `plugins.<name>`.",
	},
	E_PLUGIN_NAME: {
		cause:
			"A plugin name does not match `^[a-z][a-z0-9-]*$`, or uses the name `core`, which is reserved.",
		fix: "Rename the plugin to lowercase letters, digits and dashes starting with a letter, and not `core`.",
	},
	E_PLUGIN_OPTIONS: {
		cause:
			"The options under `plugins.<name>` fail the plugin's option validation.",
		fix: "Fix the options named in the message, or remove them.",
	},
	E_PLUGIN_UNKNOWN: {
		cause:
			"`plugins` lists a name that matches no built-in plugin (`node`, `php`, `kustomize`, `dart`).",
		fix: "Correct the plugin name in `plugins`, or remove the entry.",
	},
	E_RELEASE_ITEM_NAME: {
		cause:
			"A release item (a group or an ungrouped released unit) has a name that cannot be used in a release PR branch: it is `shared`, starts or ends with `.`, ends with `.lock`, contains `..`, or a unit id equals a group name.",
		fix: "Rename the unit (`units.<root>.id`) or the group so the name is valid and unique.",
	},
	E_RELEASE_PR_SPLIT_EDGE: {
		cause:
			"A dependency edge that propagates a patch release connects two release items that are in different release PRs.",
		fix: "Put both items in the same release PR with `releasePr` (or `defaults.releasePr`), group them under `groups`, or set `propagate: rebuild` on the dependent unit.",
	},
	E_ROOT_INVALID: {
		cause:
			"A unit root, such as a key under `units` or a root discovered by a plugin, is absolute or contains `..` segments.",
		fix: "Use repo-relative paths without `..`.",
	},
	E_ROOT_MISSING: {
		cause:
			"The root of a unit does not exist in the working tree, for example a key under `units` that points to a missing directory.",
		fix: "Create the directory, or correct or remove the `units` key.",
	},
	E_SCHEME_CLASH: {
		cause: "Two plugins register a version scheme under the same name.",
		fix: "Disable one of the plugins under `plugins`.",
	},
	E_SCHEME_UNKNOWN: {
		cause:
			"A released unit's `scheme` is not registered by any enabled plugin.",
		fix: "Correct `scheme` on the unit, or enable the plugin that provides it under `plugins`. The default scheme is `semver`.",
	},
	E_TAG_FORMAT: {
		cause: "A unit's `tagFormat` does not contain `{version}` exactly once.",
		fix: "Set `tagFormat` (on the unit or in `defaults`) to a template with a single `{version}`, for example `{id}-v{version}`.",
	},
	E_TAG_FORMAT_OVERLAP: {
		cause:
			"Two released units render the same tag format, or one existing tag matches the format of more than one released unit.",
		fix: "Give the units distinct `tagFormat` values, usually by including `{id}`.",
	},
	E_UNIT_GLOB: {
		cause:
			"A glob key under `units` uses `*` inside a path segment instead of as a whole segment, or sets `id`, `include`, `exclude` or `versionFiles`, which globs cannot set.",
		fix: "Use `*` only as a whole path segment (`packages/*`), and move those fields to an exact key.",
	},
	E_UNIT_ID: {
		cause:
			"A unit id contains characters other than letters, digits, `.`, `_` and `-`, or is `.` or `..`.",
		fix: "Set a valid `id` in `units.<root>`.",
	},
	E_UNIT_TAG: {
		cause:
			"An entry in a unit's `tags` contains characters other than letters, digits, `.`, `_` and `-`.",
		fix: "Rename the label in `units.<root>.tags`.",
	},
	E_UNIT_UNKNOWN: {
		cause: "`explain` was given a unit id that does not exist.",
		fix: "Pass an existing unit id. List ids with `tallyrelease graph`.",
	},
	E_VERSION_FILE_CLAIM: {
		cause:
			"A file is the version file of two units, is both a plugin version file and a `versionFiles` template target, or is a `versionFiles` marker file of two units (markers carry no unit id).",
		fix: "Remove the duplicate `versionFiles` entry, or set one file per unit.",
	},
	E_VERSION_FILE_MISSING: {
		cause:
			"A version file of a unit (from a plugin or a `versionFiles` entry) does not exist in the commit the release is based on.",
		fix: "Create the file, or correct or remove the `versionFiles` entry.",
	},
	E_VERSION_INVALID: {
		cause:
			"Bumping a version produced a string that is not a valid version. This does not happen for a valid current version.",
		fix: "Report it as a bug with the version named in the message and the `--verbose` output.",
	},
	W_CHANNEL_DEPRECATED: {
		cause:
			"A `branches` rule uses `channel`, a deprecated alias of `channels.build` that a later minor version removes.",
		fix: "Replace `channel: <name>` with `channels: { build: <name> }`.",
	},
	W_CHANNEL_ORDER: {
		cause:
			"A rule's `channels.cut` does not sort above its `channels.build` as a SemVer prerelease identifier (identifiers compare in ASCII order), so a build of a version ranks above or equal to a cut of the same version.",
		fix: "Pick labels whose ASCII order matches their maturity, for example `alpha` for builds and `beta` for cuts.",
	},
	W_CUT_SCHEME: {
		cause:
			"A unit with a pending release cannot be cut: its scheme does not render `<major>.<minor>.<patch>-<cut>.<n>` for the rule's `channels.cut`, for example the `flutter` scheme.",
		fix: "Move the unit to a scheme with SemVer prereleases, or ignore the warning; the unit still releases through release PRs.",
	},
	W_CYCLE: {
		cause: "The dependency graph has a cycle. The message shows the path.",
		fix: "Remove one of the edges, for example a `deps` entry. The plan still runs, but the order of units in a cycle is not meaningful.",
	},
	W_GROUP_EMPTY: {
		cause:
			"A group in `groups` selects no released unit through `units` or `tags`, so it is dropped.",
		fix: "Add member ids to `groups.<name>.units`, tag units with a label listed in `groups.<name>.tags`, or remove the group.",
	},
	W_INITIAL_BELOW_PRERELEASE: {
		cause:
			"A unit's initial version does not exceed an existing prerelease tag of that unit.",
		fix: "Raise `initialVersion` above the prerelease tag named in the message, or remove the stale tag.",
	},
	W_MARKER_NO_MATCH: {
		cause:
			"A `versionFiles` entry without `pattern` names a file with no line that carries an `x-tallyrelease-version` marker and a version of the unit's scheme, so the file is not updated for the release.",
		fix: "Add `# x-tallyrelease-version` or `<!-- x-tallyrelease-version -->` to the line that holds the version, set a `pattern`, or remove the entry.",
	},
	W_NO_BRANCH_RULE: {
		cause:
			"No `branches` rule matches the branch, so versions in the plan are null.",
		fix: "Add a rule for the branch under `branches`, for example `{ name: main, line: default }`, or pass `--branch`.",
	},
	W_NO_MATCHING_TAG: {
		cause:
			"A released unit has no tag matching its `tagFormat`, but an existing tag contains its id.",
		fix: "Rename the tag or set `tagFormat` on the unit so it matches existing tags.",
	},
	W_NO_RELEASED_UNITS: {
		cause: "A branch rule matches, but no unit is released.",
		fix: "Set `release: true` on units, or `defaults.release: true`.",
	},
	W_PLUGIN: {
		cause:
			"A plugin logged a warning. The text is prefixed with the plugin name.",
		fix: "Follow the message. It usually points at a manifest or option the plugin could not use.",
	},
	W_RELEASED_NO_BASE: {
		cause:
			"The build base is unknown, so `released` in the plan only lists releases at HEAD and leaves out earlier releases on the first-parent chain.",
		fix: "Pass `--base <ref>` or make the base resolvable (see `W_NO_FORGE` and `W_NO_LAST_SUCCESS`).",
	},
	W_RELEASE_AS_CONFLICT: {
		cause:
			"Several different `Release-As` values apply to a unit. The newest valid one wins and the message names it.",
		fix: "Remove the extra `Release-As` footers if the winner is not the intended one.",
	},
	W_RELEASE_AS_IGNORED: {
		cause:
			"A `Release-As` footer is ignored because its commit is not attributed to a released unit, or it names a unit that is not released.",
		fix: "Name a released unit (`Release-As: <unit>@<version>`), or remove the footer.",
	},
	W_RELEASE_AS_INVALID: {
		cause:
			"A `Release-As` value is not a version of the unit's scheme, or is a prerelease, or does not exceed the unit's current version. It is ignored.",
		fix: "Correct the footer value in the commit message, or drop it.",
	},
	W_RELEASE_AS_UNKNOWN: {
		cause:
			"A `Release-As: <unit>@<version>` footer names a unit that does not exist.",
		fix: "Correct the unit id in the footer.",
	},
	W_RELEASE_NOT_BUILT: {
		cause:
			"A release of a unit is at HEAD, but the unit is not in the build set. It is listed as a catch-up.",
		fix: "Build and publish the unit for that release, or ignore the warning if it was already built.",
	},
	W_UNIT_GLOB_UNMATCHED: {
		cause:
			"A glob key under `units` matches no discovered unit. Globs never create units.",
		fix: "Correct the glob, or remove it.",
	},
	W_UNIT_UNKNOWN: {
		cause: "An intent source of a plugin names a unit id that does not exist.",
		fix: "Correct the unit id in the intent source, or add the unit to the config.",
	},
	W_VERSION_FILE_NO_MATCH: {
		cause:
			"A `versionFiles` `pattern` of a unit matches nothing in its file, so the file is not updated for the release.",
		fix: "Make `pattern` match the text that holds the previous version, or remove the entry.",
	},
});
