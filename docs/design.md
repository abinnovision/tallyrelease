# tallyrelease: design

This document describes the implementation on `main`. User documentation starts at [`docs/README.md`](README.md).

Packages: `@tallyrelease/core` (pure planning core), `@tallyrelease/plugins` (built-in plugins) and `@tallyrelease/cli` (binary `tallyrelease`). Config file: `tallyrelease.yaml`. Labels: `tallyrelease: pending` / `tallyrelease: released` / `tallyrelease: stale`. Release PR branches: `tallyrelease/release/<branch>/shared` and `tallyrelease/release/<branch>/<item>`; prerelease PR branches: `tallyrelease/prerelease/<branch>/<leaf>`. PR marker: `<!-- tallyrelease-plan:v1 ... -->`. Error codes `E_*`, warning codes `W_*`.

Core function names: `loadWorkspace()` in `workspace.ts` (plugin hooks, units and graph), `computeAffected()` in `affected.ts`, `computePlan()` in `plan.ts`. Plugin hooks keep the short names `discover` and `edges`.

## A. Design

### A.1 Summary

`tallyrelease` reads git history, conventional commits and a dependency graph supplied by ecosystem plugins, and computes:

- the **build set** (what this push affected, including dependents);
- the **release set and versions** per branch line;
- release PRs, tags (including floating tags) and forge releases as effects.

Building and publishing stay with the stacks and publishers.

### A.2 Goals and non-goals

Goals: ecosystem-agnostic core; commit-driven intent; path-based attribution; separate build and release sets; deterministic prereleases with no committed state; maintenance lines; versioned plan output; runs locally and in any CI (GitHub first); pure, fixture-tested core; correctness under cancelled or reordered CI runs.

Non-goals: building, packaging, publishing; forward-porting hotfixes; AI or heuristic release notes; replacing turbo/Nx/moon; effects as plugin hooks.

### A.3 Concepts

| Term            | Definition                                                                                                                                                                                                                                                             |
| :-------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | Buildable, optionally released thing: `id`, `root`, `include`/`exclude`, effective `version` (`file` \| `tag` \| `none`), `scheme`, `tagFormat`, `propagate`, owning `plugin`, namespaced `meta`.                                                                      |
| Released unit   | Unit opted in by config (`release: true` or `defaults.release: true`). Its `version` is the version source (`file` or `tag`, from the plugin unless overlaid). Every other unit is build-only (`version: none`).                                                       |
| Version source  | Where a released unit's version lives: `file` (tags and version files) or `tag` (tags only). Declared by the plugin; config decides whether the unit is released.                                                                                                      |
| Edge            | `from -> to`: `to` depends on `from`. `pinned` is true when `to`'s published manifest must change when `from`'s version changes, or when `to` bundles `from`'s code (dart `path:` dependencies), since the shipped artifact changes even though the manifest does not. |
| Global input    | Repo file whose change marks **all** units affected for the build set and is **never** attributed for releases (lockfiles, `tallyrelease.yaml`, root `tsconfig*.json`, `turbo.json`).                                                                                  |
| Ignore          | Glob dropped before any processing (build and release).                                                                                                                                                                                                                |
| Change          | One unit of intent (normally a parsed commit) attributed to units.                                                                                                                                                                                                     |
| Line            | `default` or `maintenance`. A maintenance rule limits bumps (A.7.9).                                                                                                                                                                                                   |
| Channel         | Prerelease label. A rule has a build channel (every push, untagged) and a cut channel (prerelease PR, tag, GitHub prerelease). No channel, no prereleases.                                                                                                             |
| Build           | Prerelease of every push on a line, `<next>-<build>.<N>`, untagged.                                                                                                                                                                                                    |
| Cut             | Hand-cut prerelease: merging a prerelease PR (A.9) tags the merge commit and creates a GitHub prerelease at `<next>-<cut>.<K>`.                                                                                                                                        |
| Base tag        | Highest stable tag of a unit reachable from HEAD. Source of `from`.                                                                                                                                                                                                    |
| Line base       | Highest stable tag of a unit on HEAD's first-parent chain. Origin of the prerelease counter; without one, the unit's introduction.                                                                                                                                     |
| Build set       | Units owning files changed in `base..HEAD`, plus reverse-transitive dependents and the mates of affected group members; all units if a global input changed.                                                                                                           |
| Release set     | Released units with a pending bump since their base tag, including Changes absorbed from unreleased dependencies (A.7.6), after propagation and fixed groups.                                                                                                          |
| Group           | Fixed group (A.7.8): released units selected by `units` or `tags` that release together with one version. Tags and changelogs stay per unit.                                                                                                                           |
| Release item    | Ungrouped released unit or fixed group; releases as one. `releasePr` puts it in the shared release PR (`shared`, default) or its own (`separate`). The name `shared` is reserved.                                                                                      |
| Initial version | Version of a unit's first release (`initialVersion`, else the scheme's initial version).                                                                                                                                                                               |
| Plan            | `plan.json` (schema 1). `affected.json` (schema 1) is the build-set subset.                                                                                                                                                                                            |

### A.4 Architecture

```
                cli (imperative shell)                               core (pure)
 tallyrelease.yaml ──> config/load (zod) ────────── TallyConfig ─────┐
 fs ──────────> fs-ctx (node:fs, tinyglobby) ─ Ctx/ReadonlyFs ─┤
 git ─────────> git/reader (execFile git) ──── GitReader ──────┼──> loadWorkspace() (units, graph)
 @tallyrelease/plugins (public API only) ───── Plugin[] ───────┤    computeAffected()
 CiProvider + Forge ───> ci/base (build base) ─ BuildBase ─────┘    computePlan()
 Forge (Octokit) <── effects (reconcile, release-pr, tags, forge-release) <── Plan
 stdout / files / CiProvider (step outputs, summary) <── outputs
```

Sequence per run:

1. cli loads config and plugins, builds `Ctx` and `GitReader`, runs `loadWorkspace()` (reconcile needs units, tag formats and schemes), resolves the build base (A.7.5).
2. cli reconciles merged release PRs (A.9): tags are created locally and pushed, then the reader's tag cache is invalidated.
3. core `computePlan()` runs graph, build set, release set, versions and `released` in one call. (`computeAffected()` is the build-set subset.)
4. cli runs the `release-pr` effect and writes outputs.

Plugin hooks are awaited sequentially in config order (never `Promise.all`), so warnings and merged output are deterministic. Planning at a historical commit (`plan --head`, reconcile) uses one cli helper, `planAt(ref)`: `tallyrelease.yaml` is read and validated from the working tree, then files come from a git-backed `ReadonlyFs` at the ref (paths listed once with `git ls-tree -r -z --name-only`, blobs read lazily with `git cat-file blob` and cached; a path absent at the ref reads as absent, any other git failure, such as a blob a partial clone cannot fetch, throws `E_GIT_READ` instead of reading as absent), then `computePlan()`. Nothing is checked out, so no hooks, LFS smudge filters or cleanup are involved. Injected runs pass `deps.fsAt(ref)` instead.

Effects go through two cli seams. `Forge` lists release PRs through the issues API (label `tallyrelease: pending`, then one PR read each for head, merge and body; no search index lag), creates, updates and closes PRs (closing comments), sets the one `tallyrelease:` label (creating missing labels, optional comment), and looks up branch heads, the PR of a merge commit and releases by tag; it creates releases. `GitWriter` builds release commits on a temporary index (`read-tree`, `hash-object -w --no-filters`, `update-index --cacheinfo`, `write-tree`, `commit-tree` with `-c commit.gpgsign=false`), so the working tree, index and HEAD stay untouched. Author and committer are `tallyrelease <tallyrelease@users.noreply.github.com>` and both dates equal the given date (HEAD's committer date), so equal input gives an equal sha. Tags are written with `update-ref` (no-op at the same sha, `E_TAG_EXISTS` elsewhere unless forced). Pushes go to `origin` with `--force-with-lease` per ref (empty expected value when the ref must not exist; a failed lease is `E_PUSH_LEASE`) and optionally `--atomic`. With a token, the push resets `http.<origin>/.extraheader` and sets `AUTHORIZATION: basic <base64(x-access-token:<token>)>` through `GIT_CONFIG_*` variables, so persisted checkout credentials are replaced and the token never appears in argv or debug output. The reader caches no tags, so tags written by a run are visible to its next `planAt`.

`Forge` methods throw `ForgeError` with the HTTP `status`. The GitHub adapter wraps every Octokit error in one request hook, a 404 as `ForgeNotFoundError`; `createPr` and `createRelease` turn a 422 into `ForgeConflictError`, which `pr` and `release` treat as "already exists". `W_FORGE_ERROR` shows the status of a `ForgeError`.

The CI run context goes through `CiProvider` (`ci/provider.ts`). `detectCi(env)` always returns the GitHub Actions provider (`ci/github.ts`). Its `event`, `branch` and `baseInputs` are undefined without `GITHUB_EVENT_NAME`, so a run with only `GITHUB_REF_NAME` set takes the branch from git and resolves the base with A.7.5 row 5. `prEvent` (a pull request or merge queue event) makes effect commands skip, and `onPrHead` (such an event or a `refs/pull/` ref) denies local plugins in privileged commands. Step outputs (`--github-output`) and the step summary are written through the provider.

Purity enforcement: lint rule (see Purity rules) on `packages/core/src/**` and `packages/plugins/src/**`; core and plugins `tsconfig.build.json` set `"types": []`; core and plugins `check:purity` bundle `src/index.ts` with esbuild `--platform=neutral` and fails on any Node builtin, including transitive dependency imports (see Purity rules).

### A.5 Plugin contract (`@tallyrelease/core`)

For writing a plugin, see the [plugin authoring guide](plugins.md).

```ts
export type MaybePromise<T> = T | Promise<T>;
export const PLUGIN_API_VERSION = 1;

export interface Plugin<O = unknown> {
  apiVersion: 1; // rejected if unsupported: E_PLUGIN_API
  name: string; // /^[a-z][a-z0-9-]*$/, unique
  options?: StandardSchemaV1<unknown, O>; // validates plugins.<name> minus core-owned keys (A.6)
  discover?(ctx: Ctx<O>): MaybePromise<UnitDraft[]>;
  edges?(ctx: Ctx<O>, units: readonly Unit[]): MaybePromise<EdgeDraft[]>;
  inputs?(ctx: Ctx<O>): MaybePromise<{ global?: string[] }>; // default global inputs
  versionFiles?(ctx: Ctx<O>, unit: Unit): MaybePromise<VersionFile[]>; // only for owned units
  schemes?: Record<string, VersionScheme<any>>;
  intent?: IntentSource<O>[];
  validate?(ctx: Ctx<O>, plan: Plan): MaybePromise<string[] | void>; // returned messages are W_PLUGIN in plan.warnings
  changelog?(
    ctx: Ctx<O>,
    input: {
      unit: Unit;
      plan: Plan;
      section: string;
      cut?: { version: string } | null; // set for a prerelease cut section; its heading carries cut.version
    },
  ): MaybePromise<string>; // only for owned units; replaces the default section
}
export function definePlugin<O>(plugin: Plugin<O>): Plugin<O>; // validates name + apiVersion, returns as-is

export interface Ctx<O = unknown> {
  readonly options: O;
  readonly repo: { readonly name: string }; // GITHUB_REPOSITORY name, else origin remote, else dir name
  readonly fs: ReadonlyFs;
  readonly log: { warn(msg: string): void; debug(msg: string): void }; // warnings land in plan.warnings
}
export interface ReadonlyFs {
  // repo-relative POSIX paths, sync
  read(path: string): string | undefined; // utf8, undefined if missing
  exists(path: string): boolean;
  glob(patterns: string[], opts?: { dirs?: boolean }): string[]; // sorted; skips .git, node_modules, vendor
}
export function defaultUnitId(root: string, repoName: string): string; // "." -> repoName, else basename

/** Read-only git access. cli implements it with `git`; core/testing ships memoryGit(dag). */
export interface GitReader {
  tags(): MaybePromise<readonly TagRef[]>; // all tags, peeled to commits
  tagsMerged(ref: string): MaybePromise<readonly TagRef[]>; // git tag --merged <ref>
  isAncestor(a: string, b: string): MaybePromise<boolean>;
  isFirstParentAncestor(a: string, b: string): MaybePromise<boolean>; // a on b's first-parent chain
  log(from: string | null, to: string): MaybePromise<readonly RawCommit[]>; // --no-merges, files --no-renames, any order
  countFirstParent(from: string | null, to: string): MaybePromise<number>;
  diffFiles(from: string, to: string): MaybePromise<readonly string[]>; // --name-only --no-renames
  introduced(path: string, to: string): MaybePromise<string | null>; // oldest first-parent commit touching path: log --first-parent --reverse -- :(top,literal)<path>
  commitDate?(ref: string): MaybePromise<string>; // committer date, ISO 8601 (log -1 --format=%cI); optional for third-party readers
}
export interface TagRef {
  name: string;
  sha: string;
}
export interface RawCommit {
  sha: string;
  parents: string[];
  message: string;
  files: string[];
  date: string;
} // committer date, ISO

export type Propagate = "auto" | "patch" | "rebuild";
export type VersionSource = "file" | "tag"; // file: tags + version files written; tag: tags only
export type VersionMode = VersionSource | "none"; // effective; none: not released (build-only)

export interface UnitDraft {
  id: string;
  root: string;
  include?: string[];
  exclude?: string[];
  version?: VersionSource; // source if released, default "tag"; config decides whether it is
  scheme?: string; // default "semver"
  tagFormat?: string; // default "{id}-v{version}", "v{version}" for root "."
  propagate?: Propagate; // default config.defaults.propagate
  meta?: Record<string, unknown>; // stored at unit.meta[plugin.name]
}
export interface Unit {
  readonly id: string;
  readonly root: string;
  readonly plugin: string; // "config" for config-only units
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly version: VersionMode; // effective (A.7.1)
  readonly scheme: string;
  readonly tagFormat: string;
  readonly propagate: Propagate;
  readonly tags: readonly string[]; // from the config overlay, sorted, unique; default []
  readonly initialVersion: string | null; // overlay, else defaults.initialVersion; null: scheme.initial()
  readonly meta: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface EdgeDraft {
  from: string;
  to: string;
  reason: string;
  pinned: boolean;
}
export interface Edge {
  from: string;
  to: string;
  reasons: string[];
  pinned: boolean;
  sources: string[];
}

export interface VersionFile {
  path: string;
  read(content: string): string | undefined;
  write(content: string, next: string, ctx: WriteCtx): string;
}
export interface WriteCtx {
  unit: Unit;
  units: readonly Unit[]; // all units, for example to map package names
  versions: ReadonlyMap<string, string>;
} // unit id -> version of the release items being written

export type BumpLevel = "major" | "minor" | "patch";
export interface VersionScheme<V> {
  parse(raw: string): V | undefined; // undefined: not a version of this scheme
  format(v: V): string;
  compare(a: V, b: V): number;
  core(v: V): { major: number; minor: number; patch: number }; // limits, preMajor, floating tags
  isPrerelease(v: V): boolean; // excluded from base and line-base selection
  initial(): V; // first release without Release-As or initialVersion (semver: 1.0.0)
  bump(v: V, level: BumpLevel): V;
  release(next: V, ctx: PreCtx): V; // stable finalisation (identity for semver)
  prerelease(next: V, ctx: PreCtx & { channel: string }): V;
}

/** Git-derived data, computed by core through GitReader before calling the scheme. */
export interface PreCtx {
  unit: Unit;
  head: string; // full sha of the planned commit
  date?: string; // committer date of head, ISO 8601; absent when the reader has no commitDate
  baseTag: string | null;
  tags: readonly string[]; // ALL tags of this unit (matching tagFormat), reachable or not, scheme-sorted
  firstParent: {
    sinceLineBase: number; // countFirstParent(lineBase, head); lineBase null: from the unit's introduction
    total: number; // countFirstParent(null, head)
  };
}

export interface IntentSource<O = unknown> {
  name: string;
  collect(
    ctx: Ctx<O>,
    input: {
      from: string | null;
      to: string;
      commits: readonly RawCommit[];
      units: readonly Unit[]; // all units of the workspace, for example to map package names to unit ids
    },
  ): MaybePromise<Change[]>;
}
export interface Change {
  sha?: string; // commit-derived: attributed via that commit's files
  units?: string[]; // explicit attribution (file-based sources)
  type: string;
  breaking: boolean;
  scope?: string;
  subject: string;
  body?: string;
  notes?: string; // BREAKING CHANGE footer text
  releaseAs?: { unit?: string; version: string }[]; // Release-As footers; unit from the qualified form <unit>@<version>
  pr?: number;
  date?: string;
  files?: string[]; // consumed when released: deleted in the release commit once every unit named by the changes with the file releases in it (A.9)
}
```

`Change.files` lets a file-based source, such as the built-in `changesets` plugin, consume its intent files: core collects, over all changes of the plan, the units named by the changes that carry a file, and `releaseFiles` returns the file in `deletes` when all of them are released by the release commit's items and the file exists. A change without `units` never consumes its files. The plan lists `units` and `files` of such a change (A.8).

Core built-ins (expressed through the contract, registered as internal plugin `core`): schemes `semver` and `calver`, intent source `conventional-commits` (a small in-core parser exported as `parseCommit(message)`: header `type(scope)!: subject`, trailing `(#123)` as `pr` (also for non-conventional headers, which yield `type: ""`). Footers follow Conventional Commits: the footer block starts at the first paragraph whose first line is `Token: value` or `Token #value`, and a value runs, possibly over several lines, until the next such line. They are kept as `footers: Record<lowercased token, string[]>`; uppercase `BREAKING CHANGE`/`BREAKING-CHANGE` set `breaking`. Each commit maps to exactly one Change; the first line of each `Release-As` value becomes a `Change.releaseAs` entry (`<unit>@<version>` names a unit, a plain value applies to the units the Change is attributed to); no synthetic Changes. The plugin name `core` is reserved. No `conventional-commits-parser`, whose v7 imports `stream` and fails `check:purity`), default global input `tallyrelease.yaml`.

**Commit date.** Core calls `GitReader.commitDate` once per plan, for the planned commit (`opts.head`), and passes the result to every unit and group `PreCtx` as `date`. This is the only source of `PreCtx.date`: core reads no clock and takes no date option, so the same commit always plans the same versions. Planning a merge's first parent (A.9) uses that commit's date. A reader without `commitDate` leaves `date` unset, and `calver` then throws ("calver needs the commit date; the git reader does not provide commitDate").

**`calver`.** Versions are `Y.M.N` with plain integers (`2026.11.0`, no leading zeros) and SemVer syntax; `core()` is `{ major: Y, minor: M, patch: N }`, and `initial()` is `0.0.0`. `parse` checks no month range. `bump` gives `Y.M.(N+1)` for every level, so the level only decides that a release is pending. `release(next, ctx)` takes `Y.M` from `ctx.date` in UTC: when `next` is in that month it is kept, when the date's month is newer the result is `Y.M.0` of the date, and when it is older `next` is kept, so a release is never lower than the current version. `Release-As` values go through `release` as well, so a value in an older month moves to `Y.M.0` of the date. `prerelease` appends `-<channel>.<n>` to that same `Y.M.N`, as `semver` does. Bump limits and floating tags read the core, so a `{major}` maintenance line (`release/{major}.x`) means a year. A month rollover counts as a minor change and a year rollover as a major one, so a commit dated in the next year fails `release/{major}.x` with `E_CAP`, and one dated in the next month fails `release/{major}.{minor}.x`; calver maintenance lines only hold releases within their year or month. A release PR opened on the last day of a month and merged in the next is still tagged with its version, because reconcile plans the merge's first parent, whose date did not change; if `main` moves into the next month before the merge, the plan at the new parent differs and the PR is labelled stale (A.9). The changelog heading date is the cli clock on the day the release PR is generated (A.9), so near a month boundary it can differ from the version's month.

Commit order: `log` returns commits in any order (the cli reader uses `--topo-order`, `memoryGit` reverse declaration order; conformance checks that every commit is listed before its parents). Core never relies on it: every order-dependent rule sorts commits by committer date descending, compared as instants (`Date.parse`, since `%cI` carries offsets), then by sha ascending.

Other pure exports (A.9): `releaseFiles(workspace, plan, { fs, items, repoUrl, date, cut? })`, which also returns the changelog sections and takes `cut`, a map of `CutChanges` (`{ previousCut, changes }`) by unit id, to write cut sections only (at each item's cut version); `releasedFromTags(workspace, plan, { git, tags })`, whose entries carry `floatingTags`; `encodeMarker(marker)` and `decodeMarker(body)`; `releaseItems(workspace, plan, { cut? })`, `releaseEntries(items)` and `planEquals(marker, plan, workspace)`; `maintenanceCut(workspace, plan, item)`; for prerelease cuts (A.9) `cutChanges(workspace, plan, { items, git })` (the `CutChanges` of each member of the cut items), `previousCut(workspace, plan, { git })`, `cutEquals(marker, atH, atP)` and `cutWarnings(plan)`; `compileTagFormat(format, unitId)` and `renderTag(unit, version)`, for plugins that emit tag formats. `./testing` exports `memoryFs`, `memoryCtx` and `memoryGit`. `./testing/conformance` (requires vitest) exports the shared spec suites `gitReaderConformance(makeReader)`, run against `memoryGit` (core unit tests) and the real cli reader (cli integration), and `schemeConformance(scheme, { dateDriven? })`, run against `semver`, `calver` and the test fixture `flutter` (`dateDriven: true` skips the bump level order, the core reset and the core-keeping release checks, and the shared `PreCtx` carries a `date`). Both `GitReader` implementations agree on ancestry, first-parent counts, tag peeling and rename handling, and on `commitDate`, which conformance checks against `log` when the reader has it.

**Flutter scheme sketch** (`flutter`, a core test fixture in `test/fixtures/flutter.ts`, not exported and not registered by any plugin):

```ts
type FV = { major: number; minor: number; patch: number; build: number };
const RE = /^(\d+)\.(\d+)\.(\d+)\+(\d+)$/;
const flutter: VersionScheme<FV> = {
  parse: (s) => {
    const m = RE.exec(s);
    return m
      ? { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, build: +m[4]! }
      : undefined;
  },
  format: (v) => `${v.major}.${v.minor}.${v.patch}+${v.build}`,
  compare: (a, b) => cmpCore(a, b) || a.build - b.build,
  core: ({ major, minor, patch }) => ({ major, minor, patch }),
  isPrerelease: () => false, // prereleases are never tagged
  initial: () => ({ major: 0, minor: 1, patch: 0, build: 0 }),
  bump: (v, l) => ({ ...semverBumpCore(v, l), build: v.build }),
  release: (n, ctx) => ({ ...n, build: buildNo(ctx) }),
  prerelease: (n, ctx) => ({ ...n, build: buildNo(ctx) }), // stores reject "-beta.N"; channel stays in plan
};
const highestTaggedBuild = (tags: readonly string[]) =>
  Math.max(0, ...tags.map((t) => flutter.parse(stripPrefix(t))?.build ?? 0));
const buildNo = (ctx: PreCtx) =>
  Math.max(ctx.firstParent.total, highestTaggedBuild(ctx.tags) + 1);
```

Mobile versions are semver and the build number comes from the release list, because a build number is CI and store metadata. A `+build` version would change on every push and rebuild release PRs.

Findings folded into the contract: stable versions also need git data (`release(next, ctx)`); limits and pre-1.0 rules need a numeric core (`core()`); prerelease detection is scheme-specific (`isPrerelease`); build numbers must stay above every **tagged** build including tags not reachable from HEAD, because `firstParent.total` on a maintenance branch can be lower than on `main` (`PreCtx.tags`). Known limitation: untagged prerelease builds are invisible to every other line, so teams uploading prereleases from `main` to Play need a CI-run-number build source, which the `dart` plugin does not provide yet.

The built-in `dart` plugin is described in [`plugins/dart.md`](plugins/dart.md), and the mobile release flow in [`mobile.md`](mobile.md).

### A.6 Hook conflict rules

| Hook           | Called                                                    | Merge rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Conflict result                                                                                                                                                                                                             |
| :------------- | :-------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discover`     | Every enabled plugin, config key order                    | Concatenate. Core sets `unit.plugin`, stores `meta` at `meta[plugin.name]`. Then config `units.<root>` overlays apply field by field (overlay wins); a key containing `*` is a glob over unit roots (A.7.1). `release` comes from config only, so a plugin cannot opt a unit in. An overlay at a root with no discovered unit **always creates** a config-only unit (`plugin: "config"`); its `id` defaults to `defaultUnitId(root, repo.name)`.                                                                                          | Same `id` twice: `E_DUPLICATE_UNIT` (names both owners). Same `root` from two plugins: `E_DUPLICATE_ROOT`. Invalid glob key or glob field: `E_UNIT_GLOB`.                                                                   |
| `edges`        | Every enabled plugin, plus config `deps`                  | Union, dedupe by `(from,to)`: `pinned = OR`, `reasons` and `sources` unioned and sorted.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Unknown unit id: `E_EDGE_UNKNOWN_UNIT`. Self edge: `E_EDGE_SELF`. Cycles allowed (`W_CYCLE` with path); closure and propagation are cycle-safe.                                                                             |
| `inputs`       | Every enabled plugin                                      | Union of plugin `global`, core `tallyrelease.yaml`, config `globalInputs`. `plugins.<name>.globalInputs: false` disables that plugin's defaults; core strips this key before validating plugin `options`.                                                                                                                                                                                                                                                                                                                                 | None (union).                                                                                                                                                                                                               |
| `versionFiles` | Owning plugin, per owned `file` unit, lazily              | Config overlays may add templated text files (`units.<root>.versionFiles`, A.9); templates may share a file.                                                                                                                                                                                                                                                                                                                                                                                                                              | A plugin path claimed by two units, or a template on a plugin path: `E_VERSION_FILE_CLAIM` (`validateRelease`).                                                                                                             |
| `schemes`      | Registry built at load                                    | Name -> scheme. `semver` is reserved by core.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Raised by `validateRelease` (`check`, `computePlan`), never by `affected`. Duplicate name: `E_SCHEME_CLASH`. Unknown scheme of a released unit: `E_SCHEME_UNKNOWN`. Group members with different schemes: `E_GROUP_SCHEME`. |
| `intent`       | All sources of enabled plugins, per distinct commit range | Concatenate Changes. Per unit: bump = max. Commit-derived Changes deduped by `sha,type,breaking`, plus explicit `units`.                                                                                                                                                                                                                                                                                                                                                                                                                  | Release-As problems warn (history cannot be edited): different values for one unit, newest commit wins (`W_RELEASE_AS_CONFLICT`); see A.7.6 step 6.                                                                         |
| `options`      | At load                                                   | Validated against `plugins.<name>` minus core-owned keys (`globalInputs`). `path` and `package` are owned by the cli: it loads the plugin from that file or from that package in the repository's `node_modules` (built-in, then `path`, then `package`) and strips both keys before core reads the config.                                                                                                                                                                                                                               | `E_PLUGIN_OPTIONS` with schema issues.                                                                                                                                                                                      |
| `validate`     | Every enabled plugin, once per plan, after release math   | Receives a deep-frozen copy of the plan, one per run. Each returned message is a `W_PLUGIN` warning in `plan.warnings`, like `ctx.log.warn`. Runs in `check`, `plan`, `explain`, `pr`, `version`, `release` and `run`.                                                                                                                                                                                                                                                                                                                    | A thrown error is `E_PLUGIN_HOOK` and fails the command.                                                                                                                                                                    |
| `changelog`    | Owning plugin, per owned unit, building release files     | Receives `{ unit, plan, section, cut? }` with a deep-frozen `plan`, the default `section` and the optional `cut` (`{ version }` for a prerelease cut section, else `null` or absent) and returns the section that replaces it; units of other plugins keep the default writer. The section must start with a version heading of the released version (`cut.version` for a cut, never a version of `plan`, which carries the build number of the planned commit) and contain no other, so `releaseNotes` and later releases read it whole. | A wrong heading or a thrown error is `E_PLUGIN_HOOK`.                                                                                                                                                                       |

Hook rules: hooks are awaited one at a time in config order; inputs are frozen in dev/test; hooks must be deterministic for equal inputs; thrown errors are wrapped as `E_PLUGIN_HOOK` with plugin and hook name. Effects stay in the cli; an effects hook would be additive.

### A.7 Core algorithm

**A.7.1 Discovery.** As in A.6. Default `include` = `["<root>/**"]` (`["**"]` for `.`); default `exclude` = roots of units nested inside this unit (deepest root wins). Explicit `include` replaces the default; explicit `exclude` is appended. Effective version: `released = overlay.release ?? defaults.release ?? false`; `version = released ? (overlay.version ?? draft.version ?? "tag") : "none"`. An overlay `version` on an unreleased unit is allowed and takes effect once the unit is released; config-only units follow the same rule. Ids match `/^(?!\.\.?$)[A-Za-z0-9._-]+$/` (`E_UNIT_ID`); overlay `tags` match `/^[A-Za-z0-9._-]+$/` (`E_UNIT_TAG`) and are sorted and deduplicated; roots are normalized (`.` and empty segments dropped), must be repo-relative without `..` segments (`E_ROOT_INVALID`) and must exist (`E_ROOT_MISSING`). A root unit with `include: **` absorbs every file not owned by a nested unit, so `unattributed` stays empty in such repos; global inputs are still checked first, so a root `package.json` change remains global (deliberate over-build).

A `units` key containing `*` is a glob over unit roots. `*` matches exactly one path segment and never a segment starting with `.`; other segments match literally (`[x]` stays literal); pattern and root need the same segment count (`apps/*` does not match `apps/web/sub`). `**` or a partial star like `web-*` is `E_UNIT_GLOB`. Order: exact keys first create config-only units, then globs apply in declaration order to discovered and config-only units field by field (a later glob wins), then exact overlays merge last and win per field; `tags` replace, never union. Globs cannot set `id`, `include`, `exclude` or `versionFiles` (`E_UNIT_GLOB` with `key` and `field`; the cli zod schema rejects the four fields on glob keys with the same message), never create units, never raise `E_ROOT_MISSING`, and warn `W_UNIT_GLOB_UNMATCHED` when they match nothing.

**A.7.2 Graph.** As in A.6. Reverse adjacency precomputed; closure is BFS with a visited set. Topological order (used for propagation and the release list): Tarjan SCCs in dependency order, members of a cycle ordered by id.

**A.7.3 Attribution (path- and scope-based).** A path belongs to every unit whose `include` matches and `exclude` does not (`picomatch/posix` v4, `dot: true`). Commit file lists use `--no-renames`, so renames count for both old and new path. In the release set (A.7.6) a commit without files (`git commit --allow-empty`) is attributed to every released unit, as release-please does; the build set is unchanged, since such a commit changes no files.

`attribution.scopes` maps a Conventional Commits scope to unit ids (any unit, released or not; group names are not allowed; an unknown id fails with `E_ATTRIBUTION_UNKNOWN_UNIT`). The scope comes from the commit header only (`parseCommit(message).scope`), never from body lines of a squash commit. It is split on `,` and each part is trimmed; `S` is the union of the units of the mapped parts, and a commit with no mapped part is unscoped. Matching is exact and case-sensitive. With `F` the commit's files minus `ignore` minus `globalInputs` and `P` the path owners of `F`, a commit is attributed in the release set as follows (`attribution.mode`, default `paths`):

| Commit                              | `paths`  | `narrow` |
| :---------------------------------- | :------- | :------- |
| Unscoped or unmapped, `F` not empty | `P`      | `P`      |
| Mapped, `F` not empty               | `P ∪ S`  | `S`      |
| Mapped, files but `F` empty         | none     | none     |
| Without files, mapped               | `S`      | `S`      |
| Without files, unmapped             | released | released |
| A Change with explicit `units`      | `units`  | `units`  |

So ignored, global and lockfile-only commits are never attributed through a scope, and explicit `units` (changesets) always win. Groups and absorption apply unchanged to the result; a scope that moves a commit off an unreleased unit also moves it off that unit's absorbing dependents. Without `attribution.scopes` the output and the git calls are unchanged.

**A.7.4 Build set.**

```
if base == null:   all units affected, reason "all"; stop (no diff)
files     = git.diffFiles(base, head)             // tree-to-tree
files'    = files − ignore          // except changelogs of released units
hits      = files' ∩ globalInputs
if hits ≠ ∅:       all units affected, reason "global", build.globalInputs = hits
direct    = owners(files' − hits)                 // reason "direct"
affected  = closure(direct)                       // over dependents and group mates
                                                  // reason "dependent", via = affected direct dependencies
                                                  // else reason "group", via = affected group mates
unattributed = files' − hits − attributed
```

Group coupling: if any member of a fixed group is affected, all members are, so every unit that gets a version is built; a coupled member's dependents are affected too. Reasons are assigned after the closure with precedence `direct` > `dependent` > `group`. `affected --tag` filters after coupling, so a mate without the tag is dropped from the filtered output. Repos without `groups` are unchanged. Structural group errors (`E_GROUP_UNKNOWN_UNIT`, `E_GROUP_OVERLAP`) fail `affected`; release-only group errors do not.

A released unit owns `<root>/CHANGELOG.md` (`changelogPath`; `CHANGELOG.md` for a root unit) regardless of `ignore`, `include` and `exclude`, with reason `direct`; global inputs are still checked first. So a release commit always keeps its units in the build set, tag-only units under `ignore: ["**/*.md"]` included. `explain` lists that changelog among the unit's files.

Tree-to-tree diff needs no special casing for merges, reverts or squash merges. Unreleased units (`version: none`) are included; build selection depends on release status only through changelog ownership. Output sorted by unit id.

Scope attribution: with `attribution.scopes`, a base and no global hit, the build set re-attributes each changed file through one `git.log(base, head)` call. The diff stays the authority for which files changed. A released unit's changelog keeps its owner. Any other file `f` touched by the non-merge commits `T(f)` of the range gets the union over `T(f)` of the commit rule of A.7.3 applied to its path owners; a file that no such commit touched (a merge-only edit, or the base side of a `--base` that is not an ancestor) keeps its path owners. On a global hit all units are affected and `unattributed` stays path-based. So narrowing drops the path owners of `f` only when every commit that touched it is scoped and mapped. This is a hazard of `narrow`: it can leave out the owner of a file that really changed, including an unreleased library and its dependents. Build and release results can differ when a squash message carries a different scope than the branch commits.

**A.7.5 Build base resolution (cli, in order).**

| #   | Event                                                  | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `baseSource`                          |
| :-- | :----------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------ |
| 1   | any                                                    | `--base <ref>`; must resolve, else `E_BASE_UNRESOLVED`.                                                                                                                                                                                                                                                                                                                                                                                                                      | `cli`                                 |
| 2   | push, `before` usable (not all-zero, ancestor of HEAD) | Look up `lastSuccess` (row 4 query, `event=push`). If `lastSuccess` is an ancestor of (or equal to) `before`, use it; else use `before`. Without token: `before` plus `W_NO_FORGE`. Token present but no `lastSuccess` (first adoption, renamed workflow, all runs failed): `before` plus `W_NO_LAST_SUCCESS`. Never builds less than `before`, and covers runs cancelled while queued.                                                                                      | `forge-last-success` or `push-before` |
| 3   | pull_request / merge_group                             | `merge-base(HEAD, pull_request.base.sha)`; `merge_group.base_sha`.                                                                                                                                                                                                                                                                                                                                                                                                           | `pr-merge-base` / `merge-group`       |
| 4   | push with unusable `before`, dispatch, schedule        | `lastSuccess`: workflow path from `GITHUB_WORKFLOW_REF`; `GET /repos/{o}/{r}/actions/workflows/{file}/runs?branch=<b>&status=success&event=<e>`, where `e` is `push` for push and dispatch and `schedule` for schedule; when nightly is selected and the branch rule sets `channels.nightly`, dispatch and schedule query `schedule` and `workflow_dispatch` and keep the run that descends from the other; first `head_sha` that exists locally and is an ancestor of HEAD. | `forge-last-success`                  |
| 5   | no CI event, no CI detected                            | `merge-base(HEAD, ref)` with `ref` from `origin/HEAD`, else the first of `origin/main`, `origin/master`, `main`, `master` that resolves. No ref or no merge base: row 6. Never `E_SHALLOW_BASE`.                                                                                                                                                                                                                                                                             | `local-merge-base`                    |
| 6   | fallback                                               | `base = null`, everything affected.                                                                                                                                                                                                                                                                                                                                                                                                                                          | `none`                                |

CI is detected when `CI` is set to anything but empty, `false` or `0`, or when any of `JENKINS_URL`, `TF_BUILD`, `CODEBUILD_BUILD_ID`, `BUILDKITE`, `GITLAB_CI`, `TEAMCITY_VERSION` or `BITBUCKET_BUILD_NUMBER` is set; detected CI without a GitHub event and unknown GitHub events use row 6. Locally (row 5), `affected` answers "what did my branch change versus the default branch": on the default branch with nothing unpushed the base is HEAD and no unit is affected. Uncommitted changes are not included.

A base sha named by the event, flag or forge that is missing locally while `git rev-parse --is-shallow-repository` prints `true` is `E_SHALLOW_BASE` (exit 1), never "everything".

When the last successful run cannot be looked up, the base falls back to `before` (row 2) or to everything (rows 4 and 6) and the document carries a warning: `W_NO_WORKFLOW_CONTEXT` if `GITHUB_REPOSITORY`, `GITHUB_WORKFLOW_REF` or `GITHUB_REF_NAME` is missing, `W_FORGE_ERROR` if the forge request fails.

**A.7.6 Release set.** For each released unit (`version != none`):

1. **Tag matching:** `tagFormat` compiles to an anchored regex: literal parts and `{id}` are regex-escaped, `{version}` must occur exactly once (else `E_TAG_FORMAT`), becomes `(.+)` and must parse with the unit's scheme. A unit's tags are sorted by `compare`, ties broken by tag name (semver ignores build metadata for precedence). `check` and `computePlan()` fail with `E_TAG_FORMAT_OVERLAP` if two released units render the same format, or if any existing tag parses for more than one released unit. Unreleased units are never matched, so units sharing a format such as `v{version}` never fail `check` while unreleased.
2. **Base tag:** max by `compare` over `git.tagsMerged(head)` for the unit, prereleases skipped. **Line base:** highest such tag whose commit `isFirstParentAncestor(tag, head)`; may differ from the base tag after a maintenance branch is merged back. `sinceLineBase = countFirstParent(lineBase, head)`; lineBase null: from the unit's introduction, `countFirstParent(introduced, head) + 1` with `introduced = git.introduced(root, head)` (the oldest first-parent commit whose diff to its first parent touches the root, so the introducing commit gets 1; a unit added on a side branch is introduced by the merge). A root unit (`.`) and a unit no commit introduces count `total = countFirstParent(null, head)`.
3. **Commits:** `git.log(baseTag, head)` (no merges; group members use the group base tag, A.7.8), in core commit order (A.5); intent sources run once per distinct range. Files minus `ignore` minus `globalInputs`, then attribution; a Change with `units` is attributed to those units; lockfile-only commits never bump. The unit's Changes are those attributed to `{R} ∪ reach(R)` (absorption, below); each commit counts once.
4. **Own bump:** max over attributed Changes via `bumps.types` (merged over the defaults `feat: minor`, `fix`/`perf`/`revert: patch`; breaking: major, whatever the type). If `core(from).major == 0`: breaking changes use `preMajor.breaking` (default `minor`) and changes whose type level is `minor` use `preMajor.feat` (default `minor`), so `bumps.types: { feat: patch }` stays `patch`. The `preMajor.breaking: minor` default differs from release-please's default (`bump-minor-pre-major: false`, breaking gives `major`); repos relying on that default set `preMajor.breaking: major` for release-please parity.
5. **From version:** the base tag version. Without a base tag (first release) `from` is `null` and `next = releaseAs ?? initialVersion` (unit overlay, else `defaults.initialVersion`, else `scheme.initial()`); commits since the root decide only whether the unit is pending. An initial version that does not exceed the unit's highest prerelease tag warns `W_INITIAL_BELOW_PRERELEASE`. A repo whose history predates its tags adopts tallyrelease by pushing a baseline tag (for example `core-v1.4.0` on the last release commit).
6. **Release-As:** a footer value applies to the units its commit's Change is attributed to; the qualified form `<unit>@<version>` applies only to the named unit and adds no bump or change entry for it. Within one commit a qualified value beats a plain one for that unit. A single leading `v` is stripped before parsing (release-please parity). For an ungrouped unit the value overrides `next`, even below the computed bump; it must parse as a stable version (prerelease values such as `2.0.0-rc.1` are rejected) and exceed `from`, else it is ignored with `W_RELEASE_AS_INVALID`. Different values for one unit: the newest commit in core order wins, `W_RELEASE_AS_CONFLICT`. Unknown unit: `W_RELEASE_AS_UNKNOWN`. A qualified value naming an unreleased unit, or a plain value on a commit attributed to no released unit: `W_RELEASE_AS_IGNORED`. Footers are not absorbed. All Release-As problems warn, because history cannot be edited.

A unit is pending when it has a bump or a Release-As value; `next` is `null` otherwise. Unreleased units are never pending. No released unit while a branch rule matches: `W_NO_RELEASED_UNITS`. A released unit without a matching tag while some tag contains its id (delimited by non-alphanumeric characters): `W_NO_MATCHING_TAG`, a hint at tag format drift.

**Absorption (unreleased units are transparent to released dependents).** For a released unit `R`, `reach(R)` is the set of unreleased units found by a reverse walk over edges (any edge, pinned or not) starting at `R`'s dependencies, with a visited set, never stepping into or through a released unit. Cycles among unreleased units terminate through the visited set. Absorbed Changes contribute a level only when their own level (type mapping, or breaking) is set, so `chore:` gives nothing. With `bumps.absorbed: patch` (default) that level is `patch` for every such Change, `feat` and breaking included; with `minor` it is the own level capped at `minor` (`fix` patch, `feat` and breaking minor). An absorbed Change never bumps `R` by major, because it breaks in-repo callers, not `R`'s consumers (a real break of `R` is a commit attributed to `R` or `Release-As`). A commit touching an absorbed unit and `R`, or reaching `R` by two paths, is one Change. Absorption reads `R`'s own range (since `R`'s base tag). In the plan, `absorbedFrom` lists the absorbed units of `R`'s Changes not attributed to `R` itself, and each such Change carries `via`, the first of its absorbed units by id. Example: a `fix:` or `feat:` in an unreleased `packages/db` patches every released app that depends on it, directly or through other unreleased units; a `chore:` in `packages/tsconfig` reaches the apps and bumps nothing.

**A.7.7 Propagation.** Fixpoint over edges in topological order (terminates: bumps only increase). For `from -> to` where `from` has a bump, policy = `to.propagate`, with `auto = pinned ? patch : rebuild`. `from` has a bump when it is pending (own or absorbed bump, Release-As, or a bump raised by propagation). `patch` raises `to` to at least `patch` and adds `from` to `propagatedFrom` (sorted); a raised unit is pending and a propagated patch is a pending bump for kinds (A.7.10). Cycle members can patch each other. `rebuild` changes nothing in the release set. Propagation onto an unreleased dependent is a rebuild only. A propagated patch onto a released unit without a base tag is its first release (`next` = initial version, A.7.6 step 5). For an ungrouped unit, Release-As stays the explicit target: propagation raises its `bump` and lists the source, but `next` is the Release-As value. Group raising runs in the same fixpoint: a group with a pending member makes every member pending at the members' max bump, so a raised member propagates to its dependents and a propagated patch on one member raises its group.

Propagation through unreleased units: a released `R1` that reaches a released `R2` only through unreleased units is treated as a direct edge `R1 -> R2`, with `pinned` taken from the first hop (`R1 -> U`), the hop that changes `U`'s shipped content. With several paths or an additional direct edge, the first-hop `pinned` values are OR-combined, as in edge dedupe (A.6). Example: `core` (released) feeds `adapter` (unreleased) feeds `app` (released); a `fix:` in `core` releases `core` and propagates to `app` per its policy.

Node pinning:

| Field                  | Exact version, `workspace:*`, `workspace:x.y.z` | `^`, `~`, `workspace:^`, `workspace:~`, other ranges |
| :--------------------- | :---------------------------------------------- | :--------------------------------------------------- |
| `dependencies`         | pinned                                          | not pinned                                           |
| `optionalDependencies` | pinned (same as `dependencies`)                 | not pinned                                           |
| `peerDependencies`     | not pinned                                      | not pinned                                           |
| `devDependencies`      | not pinned                                      | not pinned                                           |

All four produce edges (build set); only pinning differs.

**A.7.8 Fixed groups.** `groups` maps a name (unit id characters; group names and unit ids are separate namespaces) to `units` (ids) and/or `tags` (released units with any of the tags). `loadWorkspace` resolves members: unknown id `E_GROUP_UNKNOWN_UNIT`, a unit in two groups `E_GROUP_OVERLAP`, a group selecting nothing `W_GROUP_EMPTY`. `validateRelease` rejects an unreleased member named in `units` (`E_GROUP_NOT_RELEASED`) and members with different schemes (`E_GROUP_SCHEME`).

When any member is pending, all members release with one shared version; members without changes get `changes: []` and the group version. The group base tag is the highest stable member tag merged into HEAD, and the group line base the highest such tag on HEAD's first-parent chain; for equal versions the tag whose commit descends from the other's wins. `groupFrom` is the group base version. A member's commit range (A.7.6 step 3) starts at its own base tag when that tag's commit descends from the group base tag's, else at the group base tag, so changes a member already released alone are not counted again. `next = max(bump(groupFrom, L), max_i releaseAs_i)` with `L` the max member level after propagation; on a first release (no group base tag) the bump is replaced by the max of the members' initial versions. A member's Release-As at or below `groupFrom` is ignored with `W_RELEASE_AS_INVALID` (the message names the group); values of several members combine by max, without a conflict. One group `PreCtx`: `unit` = first member by id, `baseTag` = group base tag, `tags` = union of member tags (scheme-sorted), `sinceLineBase` = first-parent commits since the group line base, without one the max over the members' counters (the oldest introduction wins), `total` = max over members; `scheme.release`/`scheme.prerelease` run once and the result is assigned to every member. An absorbed bump is a pending bump: a member released only through absorption behaves like one with a direct change. Tags and changelogs stay per unit; a member's `from` and `baseTag` in the plan are its own, the group's are in `groups[]`.

**A.7.9 Branch rules and maintenance limits.** First rule matching `--branch` or the current branch wins. Patterns are anchored and support `*` (any characters, including `/`) and `{major}`/`{minor}` captures (`0|[1-9][0-9]*`); each token at most once, `{minor}` only with `{major}`, anything else in braces is `E_BRANCH_RULE`. A maintenance rule caps bumps at `minor` with `{major}` and at `patch` with `{minor}` (`line.maxBump`).

| Rule shape                  | Default (relative) check per releasing release item       | Absolute check                                                                                                                 |
| :-------------------------- | :-------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------- |
| `release/{major}.x`         | max bump `minor` (`core(next).major == core(from).major`) | only if the rule sets `unit: <id>` or `group: <name>`, or the repo has exactly one release item: `core(from).major == {major}` |
| `release/{major}.{minor}.x` | max bump `patch` (same major and minor as `from`)         | as above, also `core(from).minor == {minor}`                                                                                   |

A release item is an ungrouped released unit or a fixed group; a group is checked with `groupFrom` and the group `next`. The plan records the limit in `line.maxBump` and the absolute target in `line.absolute` (`unit` or `group`, also for a single release item). `unit` and `group` are mutually exclusive and only allowed on a maintenance rule with `{major}`; a `unit` that is not an ungrouped released unit or an unknown `group` is `E_BRANCH_RULE` (`validateRelease`). First releases (no `from`) are not checked.

Violation: `E_CAP` naming the unit or group, the limit, `from`, `next` and the commit(s) that produced the offending bump (sha, subject, level and `via` for absorbed changes): changes whose level exceeds the limit and Release-As values off the line. For a group, a commit seen by several members is listed once with its highest level. A Release-As above the limit is `E_CAP` like a bump. Absolute mismatch: `E_CAP_BASE` naming the branch, the unit or group (marked as the only release item when the rule names none) and its `from`, checked whether or not the item releases. Typical causes: the branch was cut from or merged with a commit carrying a newer tag, or it is a next-major branch, which maintenance rules do not support (use a default-line rule with a channel). The implicit check stops once a second release item appears; add `unit:` or `group:` to the rule to keep it. Relative limits keep monorepos correct: `release/1.x` named after `web` does not block `api` at `5.3.0` from releasing `5.3.1`. No matching rule: build set computed, `line: null`, versions `null`, `W_NO_BRANCH_RULE`; `from`, `bump` and `next` are still computed with default-line rules.

Channels: a rule's `channels: { build?, cut? }` name the prerelease labels of every push (`build`, A.7.10) and of hand-cut prereleases (`cut`, A.9). Each is a literal `[0-9A-Za-z-]+` with at least one letter or dash outside tokens, optionally containing `{major}`/`{minor}` tokens captured by the same rule (e.g. `rc-{major}` renders `rc-1` on `release/1.x`). Errors raised by `validateRelease` (`check` and `computePlan`): same template on two rules, across both kinds, or `build` equal to `cut` (`E_CHANNEL_DUPLICATE`), a channel on a rule whose pattern contains `*` (`E_CHANNEL_WILDCARD`), any other token or character (`E_CHANNEL_INVALID`). `channel` is a deprecated alias of `channels.build` for one minor version and warns `W_CHANNEL_DEPRECATED`; together with `channels.build` it is `E_CONFIG`, together with `channels.cut` it is allowed. `W_CHANNEL_ORDER` warns when `cut` does not sort above `build` (SemVer compares labels in ASCII order, so a cut would rank at or below builds of the same `next`). `W_CUT_SCHEME` warns for a pending unit whose scheme cannot render a cut (for example `x.y.z+build`, `cut: null`); `cutWarnings(plan)` returns it and `pr` prints it, plans never fail on it.

**A.7.10 Version and kind.**

| In build set | Pending bump | Build channel | Kind                              | Version                                                                           |
| :----------- | :----------- | :------------ | :-------------------------------- | :-------------------------------------------------------------------------------- |
| yes          | yes          | set           | `prerelease`                      | `scheme.prerelease(next, ctx)`; semver: `{next}-{build}.{N}`, `N = sinceLineBase` |
| yes          | yes          | none          | `rebuild`                         | `null`                                                                            |
| yes          | no           | any           | `rebuild`                         | `null`                                                                            |
| no           | yes          | any           | `none` (listed only with `--all`) | `null`                                                                            |

Beside `version`, a pending unit gets `cut` when the rule has `channels.cut`: `scheme.prerelease(next, ctx with N+1)` (`N+1` is the number of the next first-parent commit), kept only when it has the cut form (`isCutVersion`: exactly `<major>.<minor>.<patch>-<cut>.<n>`) and sorts below `next`, else `null` (custom formats such as `x.y.z+build`). `cut` never changes the kind or `version`, so builds keep their `N`. Group members share `next`, `version`, `cut` and `N` (A.7.8). Unreleased units never have a pending bump: they are kind `rebuild` when affected and never listed as kind `none` under `--all`. Units outside the build set without a pending release are not listed. `next` is set for every pending unit, whatever its kind.

Stable releases are not units of the HEAD computation. `plan.released` is derived from durable facts only: every stable unit tag whose commit lies on HEAD's first-parent chain in `(build.base, HEAD]`; a maintenance tag reached only through a merge-back is not listed. When `base` is `null` only tags at HEAD are listed, with `W_RELEASED_NO_BASE` when earlier releases on the chain are left out, so a run without a base never re-emits history. Core fills it with `withReleased(workspace, plan, { git })`; `computePlan` leaves `released` empty, so `pr`, `version` and `explain` neither read the extra tags nor warn; `plan` and `run` fill it. `run` fails with `E_BASE_REQUIRED` before any effect when the base is `null` because the forge failed (`W_FORGE_ERROR`) instead of emitting less (`run` needs a token, so `W_NO_FORGE` cannot cause it). `releasedFromTags(workspace, plan, { git, tags })` builds entries for named tags; the caller passes the union by tag of the `plan.released` tags and the tags a reconcile created in the same run (same-sha no-op tags included). Group members are listed per unit. Order: oldest release commit on the first-parent chain first, then plan unit order (topological), then tag name; `line` is the matched rule's kind. `catchUp` is `releaseSha != head` or the unit is not in the build set (`affected` null); a release at HEAD of a unit outside the build set warns `W_RELEASE_NOT_BUILT` (with `unit`) and is listed as a catch-up. `latest` is true for the unit's highest stable tag among all its matched tags, never on a maintenance line; reconcile uses it for `make_latest`. Core sets `forge: null`. The cli (`releasedForge`) fills it from the reconcile of the same run (PR number and URL, release URL from creating or finding the release, `null` for a release a dry run would create), else looks up `prForCommit(releaseSha)` and `releaseByTag(tag)`; without a forge, or on a forge error in `plan` (`W_FORGE_ERROR`), `forge` stays null. Because the build base falls back to `lastSuccess` after a failed run (A.7.5), releases whose publish failed are emitted again by the next run; publishers treat "already published" as success.

**Cut tags.** With `line.cut` set, `released` also lists the unit's cut tags, as entries with `prerelease: true`, `latest: false` and no floating tags; `highest` stays stable-only, and cut tags never become the base tag or line base. A tag counts as a cut tag through three checks that apply where each makes sense:

- (i) form, pure: `isCutVersion(scheme, v, cut)` is exact (`<major>.<minor>.<patch>-<cut>.<n>`, `n` positive), so `1.3.0-x-beta.4` is not a `beta` cut and `rc-1` labels parse; tags of other labels are excluded. `released` and `releasedFromTags` apply it.
- (ii) ancestry, git: the commit is on the chain of the relevant head (`plan.head` in `previousCut`, `P` for the reconcile guard, HEAD for the `pr` guard) and past the unit's line base (the group line base for a group; no bound before the first stable release). It excludes main's `1.5.0-beta.3` on `release/1.x`. `released` relies on its existing base and first-parent checks instead.
- (iii) below `next`: applied in `render` and `previousCut`, which always have `next`. `released` skips it, since a plan with `all: false` has no `next` for an unaffected catch-up.

`previousCut` is the highest cut tag (`scheme.compare`) passing all three at `plan.head`, else null, and the delta of a cut is measured from `previousCut ?? baseTag`: the plan's changes not reachable from `previousCut`, where a change without a sha (a changeset) counts only when one of its files changed since `previousCut`; after a label rename it falls back to `baseTag`.

`N` monotonicity: along a line's first-parent chain, `sinceLineBase` grows by at least 1 per commit, and the line base only moves when a stable tag of the unit lands on that chain, which also raises `next`, including a tag created from the line itself (that release becomes the new `from`). Merging a maintenance branch back moves the base tag (e.g. 1.4.2 to 1.4.3) but not the line base, so `N` never drops while `next` stays 2.0.0. Without a line base `N` counts from the unit's introduction, which is fixed history; the first stable tag on the chain moves the origin to that line base and raises `next`. The sha (`plan.head`) is the deployable identity of `rebuild` units and is never part of the version string.

### A.8 Plan and affected schema (v1)

```ts
interface AffectedDoc {
  // tallyrelease affected --json
  schema: 1;
  tool: string; // "tallyrelease@0.1.0"
  repo: string;
  branch: string;
  head: string;
  build: {
    base: string | null;
    baseSource:
      | "cli"
      | "push-before"
      | "pr-merge-base"
      | "merge-group"
      | "forge-last-success"
      | "local-merge-base"
      | "none";
    all: boolean;
    globalInputs: string[];
  };
  units: {
    id: string;
    path: string /* = Unit.root, "." for root */;
    plugin: string;
    reason: "direct" | "dependent" | "global" | "all" | "group";
    via: string[];
    released: boolean; // Unit.version != "none"
    tags: string[]; // Unit.tags
  }[];
  unattributed: string[];
  warnings: { code: string; message: string; plugin?: string; unit?: string }[]; // unit: the unit a warning concerns
}

interface Plan extends Omit<AffectedDoc, "units"> {
  // tallyrelease plan --json
  line: {
    rule: string; // the matching branch rule's name
    kind: "default" | "maintenance";
    channel: string | null; // build channel, rendered with the rule's captures; the nightly channel on nightly runs
    channelKind: "build" | "nightly" | null; // which channel `channel` is, null without one
    cut: string | null; // cut channel, rendered the same way
    maxBump: "minor" | "patch" | null;
    absolute: {
      unit: string | null;
      group: string | null;
      major: number;
      minor?: number;
    } | null;
  } | null; // null: no rule matches (W_NO_BRANCH_RULE)
  units: UnitPlan[]; // topological order, cycles by id
  groups: GroupPlan[]; // sorted by name
  released: ReleasedUnit[]; // from release tags in (build.base, HEAD] when filled by withReleased (A.7.10), else []
}
interface UnitPlan {
  id: string;
  path: string /* = Unit.root */;
  plugin: string;
  scheme: string;
  tags: string[]; // Unit.tags
  group: string | null;
  affected: {
    reason: "direct" | "dependent" | "global" | "all" | "group";
    via: string[];
  } | null;
  kind: "prerelease" | "rebuild" | "none";
  baseTag: string | null;
  lineBaseTag: string | null;
  from: string | null; // null: first release
  bump: BumpLevel | null;
  releaseAs: string | null; // the applied Release-As value
  propagatedFrom: string[];
  absorbedFrom: string[]; // unreleased unit ids whose Changes were absorbed (A.7.6), sorted, unique
  next: string | null; // null: not pending
  version: string | null; // set for kind prerelease
  cut: string | null; // <next>-<cut>.<N+1>; null: no cut channel, not pending or not cuttable (W_CUT_SCHEME)
  sha: string; // plan head
  changes: {
    // core commit order (A.5)
    sha?: string; // absent for file-based changes
    type: string;
    breaking: boolean;
    scope?: string;
    subject: string;
    notes?: string; // BREAKING CHANGE footer text
    pr?: number;
    via?: string; // absorbed unit
    releaseAs?: string; // this commit's Release-As value for the unit, normalized; only values that parse
    units?: string[]; // units the change names; set with files
    files?: string[]; // Change.files (A.5)
  }[];
}
interface GroupPlan {
  name: string;
  members: string[];
  baseTag: string | null;
  from: string | null;
  bump: BumpLevel | null;
  next: string | null;
  version: string | null;
  cut: string | null; // as UnitPlan.cut, shared by the members
}
interface ReleasedUnit {
  id: string;
  path: string;
  version: string;
  tag: string;
  floatingTags: string[];
  releaseSha: string; // commit the tag points to (PR merge_commit_sha)
  catchUp: boolean; // not built from HEAD by this run (release sha differs from HEAD, or the unit is outside the build set)
  forge: {
    pr: { number: number; url: string } | null; // PR that merged releaseSha
    release: { url: string } | null; // forge release of the tag
  } | null; // null: not looked up
  line: "default" | "maintenance";
  latest: boolean; // highest stable version tagged for the unit, never on a maintenance line
  prerelease: boolean; // a cut tag (A.7.10); latest is false
}
```

A group member's `bump`, `next` and `version` are the group's and its changes are read from the group range (A.7.8), while its `from` and `baseTag` are its own; `groups[]` carries the group's base tag and `from`. `explain` prints the source of a member's `next` when it is not the group bump (for example `group sdk, release-as`).

`explain` and the changelog list absorbed Changes under the released unit with `via <unit>`. Build selection in `AffectedDoc` depends on release status only through changelog ownership (A.7.4); `released` otherwise only reports it.

The cli publishes `plan.schema.json`, `affected.schema.json` and `explain.schema.json` (generated from zod) in the npm package (exports `@tallyrelease/cli/plan.schema.json`, `@tallyrelease/cli/affected.schema.json` and `@tallyrelease/cli/explain.schema.json`). The schemas are strict (`additionalProperties: false`). Within schema 1, new optional fields and new enum values are allowed; consumers validate with the schema of the tool release they run. Removing or renaming fields bumps `schema`. Fields without a value are emitted with their empty values, never omitted (`group: null`, `groups: []`, `released: []`, `cut: null`).

### A.9 Release flow

Every run on a line branch, after step 1 of A.4 (config, plugins, `loadWorkspace()`, build base):

1. **Reconcile (tagging).** List closed PRs with head `tallyrelease/release/<branch>/shared`, `tallyrelease/release/<branch>/<item>` or `tallyrelease/prerelease/<branch>/<leaf>`, base `<branch>`, `merged_at` set and label `tallyrelease: pending`, oldest first. The label is only a work queue for tagging; publishing never depends on it. For each PR, parse the marker `<!-- tallyrelease-plan:v1 base64({ head, releaseCommit, releases: [{ id, version, tag }] }) -->` and require:
   - `pr.head.sha == releaseCommit` (body and branch belong together; a racing rewrite fails this),
   - `merge_commit_sha` is an ancestor of HEAD,
   - **plan equality** (`planEquals`): every marker release equals the `{ id, version, tag }` of that unit in `planAt(firstParent(merge_commit_sha))`, and every group the marker touches is complete. Pending items outside the marker are ignored, so merging one separate PR never makes the others stale. This accepts merge queues where main moved without changing the release, and rejects merges whose versions would now differ.

   A PR on a `tallyrelease/prerelease/` head is a cut PR. It replaces plan equality with the cut checks, with `M` = `merge_commit_sha`, `P` = `firstParent(M)` and `H` = `marker.head` (`K = N(H)+1`; `planAtCommit(H)` and `planAtCommit(P)` use the run's git and every tag the run already created):
   - `H` is a first-parent ancestor of `P`, so the PR was built on the line;
   - `H` descends from the latest cut tag of each marker item on `P`'s chain, including tags created earlier in the run, so an older head cannot yield an existing `K` (`E_TAG_EXISTS`) that aborts later PRs;
   - `cutEquals(marker, atH, atP)`: the cut entries of the marker's items re-derived at `H` equal the marker's, and each marker item has the same `next`, members and `line.cut` at `H` and `P`; touched groups are complete, other items are ignored. With `P == H` one plan serves both.

   Main may move between `H` and `M` without making the PR stale; a change of `next`, members or `line.cut`, or a merge after the stable release PR, does.

   A PR whose `merge_commit_sha` is not in HEAD (a re-run of an old run) is left `pending` for a later run and never labelled stale. The plan at the first parent is computed with the working-tree config, the files of that commit and every tag the run already created, so each PR is checked after the tags of the earlier ones exist locally. A direct-push `chore(release): ...` commit without a PR is never listed and so ignored.

   When every marker tag already points at `merge_commit_sha` (a run after a partial failure), plan equality is skipped, so a later config change cannot block the recovery, and nothing is pushed unless a floating tag moves. Valid: create tags locally at `merge_commit_sha` (existing tag on the same sha: no-op; different sha: `E_TAG_EXISTS`, the run fails before pushing that PR's tags; PRs earlier in the same run may already be tagged and pushed), take the floating tags from `releasedFromTags()` (`floatingTags` of each entry, none for a cut), then push version tags and floating tags (`+refs/tags/...`) in one atomic push per PR with the token. The reader has no tag cache, so later plans see the new tags. Create a forge release per unit when `releaseByTag` finds none (a 422 on create counts as existing): name as release-please (`<prefix>: v<version>` when the tag ends in `-v<version>`, so `cli-v0.2.0` is `cli: v0.2.0`, else the tag), body = the unit's top `CHANGELOG.md` section at the merge sha, `make_latest` from the entry's `latest` (the unit's highest stable tag, never on a maintenance line), so a late release creation never takes latest back. A cut tags `M` with the version derived at `H` and its release has `prerelease: true` and `make_latest: false`; its body is the delta since the previous cut (`previousCut ?? baseTag`) rendered by `releaseFiles({ cut })` at `P` (its `sections`, hook warnings go to the run's warnings), with the items rebuilt from `marker.releases` and the cli clock's UTC date, so it includes changes that landed between `H` and `M`, while the committed cut section does not. Cut tags are records only: no version is derived from them. Relabel `tallyrelease: released`. Invalid (no or malformed marker, head is not `releaseCommit`, plan equality fails): relabel `tallyrelease: stale` with a comment giving the reason; no tags.

2. **Plan** at HEAD. Tags from step 1 are visible because they exist in the local repo and the reader caches no tags. `plan.released` comes from tags in `(build.base, HEAD]` (A.7.10), so a release whose publish failed is re-emitted until a run succeeds, united by tag with the tags of every PR step 1 reconciled (same-sha no-op tags included), so a release reconciled by a run whose base is already past its merge is still listed. A null base caused by a forge failure fails the run with `E_BASE_REQUIRED` before step 1; without a base otherwise (first adoption) only releases at HEAD and those of step 1 are listed.
3. **Release PR** (`tallyrelease pr`). Skipped with `W_PR_HEAD_BEHIND` when HEAD is not the remote tip of `<branch>` (`branchSha`), so a re-run of an old run changes no PR; then fails with `E_PENDING_RECONCILE` while a merged PR labelled `tallyrelease: pending` exists on `<branch>` that step 1 of the same run did not reconcile. Desired PRs: one shared PR for all `shared` items and one per `separate` item (see Release PRs below), plus the prerelease PRs of cut channels (see Prerelease PRs below); both prefixes go in one wanted set, so the push, label, close and branch-delete rules cover them together. Per desired PR: `releaseFiles` of its items at HEAD (changelog date = the UTC date of the cli clock), then `commitFiles(HEAD, files, deletes, title)` on a temporary index with the identity from `GIT_AUTHOR_*`/`GIT_COMMITTER_*` (default `tallyrelease <tallyrelease@users.noreply.github.com>`) and HEAD's committer date as both dates, so the same HEAD, files and day give the same sha (`releaseCommit`). The open PRs (pending label, heads in this repository) are read once and matched by head branch; the remote branch sha (`branchSha`, the refs API) decides: the push is skipped when it equals the computed sha, otherwise all changed branches go in one atomic push with `--force-with-lease=refs/heads/<pr branch>:<branchSha>`, empty when the branch does not exist. Then the PR is created and labelled `tallyrelease: pending` (a 422 because an unlabelled open PR exists for the branch updates that PR instead), or its title and body are updated when the rendered body (which includes the marker with `head` and `releaseCommit`) differs, and the pending label is set again. Open pending PRs on `<branch>` that are not desired (empty release set, an item switched mode), and older PRs sharing a head with a newer one, are closed with a comment; branches of undesired PRs under `tallyrelease/release/<branch>/` and `tallyrelease/prerelease/<branch>/` are deleted with a lease before the PRs are closed. Merged PRs are never touched by `pr`. The body is one `<details><summary><id>: <version></summary>` block per unit holding its changelog section, then the marker.
4. **Outputs.** The plan of step 2 goes to `--out`, `--github-output` (`plan`) and `--summary`. `tallyrelease run` performs steps 1 to 4 in this order; `release` and `pr` perform steps 1 and 3 alone.

**PR body size.** The marker carries only `{ head, releaseCommit, releases }`, never the full plan. The human changelog part is cut to whole unit sections with a note so the body stays under 60,000 characters (GitHub limit 65,536).

**Maintenance hint.** On the default line, when an item's `next` has a higher `core().major` than its `from`, the body adds a note under the item's sections (`maintenanceCut(workspace, plan, item)`): the first maintenance rule with `{major}` and no `*` that targets the item or nothing, rendered from `from`, and `git push origin <tag>:refs/heads/<branch>` with the item's base tag (the group base tag for a group). First releases, maintenance lines and repos without such a rule get no note. Notes count toward the body size; the marker always stays.

**Release PRs.** Each pending release item (`releaseItems`: a group or an ungrouped released unit with a stable `next`) goes to the shared PR on `tallyrelease/release/<branch>/shared` (`releasePr: shared`) or to its own PR on `tallyrelease/release/<branch>/<item>` (`separate`). Every PR branch is a leaf under its line branch, so shared and separate PRs never conflict; a group is never split. The marker (`encodeMarker`, base64 of UTF-8 JSON through a pure helper) holds the releases of the PR's items only.

**Prerelease PRs.** With `channels.cut`, each pending release item with a listed delta (`releaseItems(workspace, plan, { cut: true })`, version from `cut`) gets a PR on `tallyrelease/prerelease/<branch>/<leaf>`, with the leaf and `releasePr` rules of release PRs, so shared and separate cut PRs never conflict and a group is never split. The commit holds changelog sections only (a cut section above `previousCut ?? baseTag`, older cut sections kept) and no version files, so the line's manifests keep the last stable version and publishers stamp the cut version as they stamp builds. The version is `<next>-<cut>.<K>` with `K = N(H)+1`, `H` the commit the PR is built on (its marker `head`) and `N(H)` the first-parent commit count since the line base at `H` (A.7.10). The marker has the shape of a release PR's, with cut versions and tags in `releases`. Titles are `chore(release): <branch> <cut>` for the shared PR and `<item>@<cut version>` for a separate one.

An open cut PR is kept as is (no push, no body edit) while its intent is unchanged: its leaf's desired items equal the marker's by name, members and `next`; `H` is a first-parent ancestor of HEAD and descends from the latest cut tags on HEAD's chain; `cutEquals` holds for `H` and HEAD; and no listed change of its units landed after `H`. Otherwise the PR is rebuilt at HEAD with a new `K`. File content is not compared, so a kept cut PR is not rebuilt when `CHANGELOG.md` is edited by hand on main; close it to get a fresh one. The guard also keeps a kept PR taggable; without it a manually pushed cut tag would produce stale merges in a loop. A stable merge changes `next`, so `pr` closes the cut PR and deletes its branch, and a stale cut merge leaves its changelog-only commit on main without a tag; the next cut section replaces sections above `previousCut ?? baseTag`, so a stable changelog holds one section. Under merge queues `K` can be lower than `N(M)`; it stays unique and increasing per label and `next`. Cost: one extra workspace load per open cut PR per run, and one per merged cut PR with `P != H`.

**Floating tags** (`tags.floating`, tokens `{id}`, `{major}`, `{minor}`): core renders `ReleasedUnit.floatingTags` (pure, over the unit's tag names) and keeps a name only if the released version is the highest stable version among all of the unit's tags that render to the same name. So `v1` moves to `1.4.3` on `release/1.x` while `v2` stays put, and a maintenance release never moves a newer line's tag.

**Changelog writer** (core, pure, release-please format in `changelog.ts`; the owning plugin's `changelog` hook may replace a unit's section, A.6): `<root>/CHANGELOG.md` per unit, also per group member, for stable releases and prerelease cuts (cut sections, see Prerelease PRs). Heading `## [<version>](<repo>/compare/<baseTag>...<tag>) (<date>)`, or `## <version> (<date>)` without a base tag or repo URL. The date is the date the release PR is generated, passed in by the cli (core reads no clock), so a rebuild on a later day changes the section; reconcile and plan equality compare releases, never file content. Sections: `⚠ BREAKING CHANGES` (the `BREAKING CHANGE` footer text, else the subject), `Features`, `Bug Fixes`, `Performance Improvements`, `Reverts`, hidden types only when breaking or carrying Release-As, then `Dependencies` (`* The following workspace dependencies were updated` / `  * <field>` / `    * <name> bumped to <version>`, from edge reasons, only for dependencies released in the same release PR). Breaking notes follow release-please: the last `BREAKING CHANGE` footer, its first paragraph on one line, list or `####` lines kept indented below. Entries `* **<scope>:** <subject> ([#<pr>](<repo>/issues/<pr>)) ([<sha7>](<repo>/commit/<sha>))`, absorbed ones with ` (via <unit>)`, sorted like release-please (scope and linked subject concatenated, compared with `localeCompare`, over changes in core commit order); a group member with nothing listed gets `* **<id>:** Synchronize <group> versions`. Without a repo URL there are no links. The writer keeps the text before the first version heading (`##` or `###`, linked or plain), replaces every section whose version is greater than the base version (untagged leftovers; without a base version, sections not below the new one) with the new section on top, and creates `# Changelog` when the file is missing, so reruns and stale recoveries never duplicate sections. The release commit body has no line starting with a footer token, so squash merges add no footers.

**Version files.** Unit overlays list templated text replacements in `versionFiles`: `{ file, pattern }`, `file` relative to the repository root, tokens `{id}`, `{version}`, `{major}`, `{minor}`, `{patch}`. `file` is normalised (`./README.md` is `README.md`); `.`, absolute paths and `..` segments are `E_CONFIG`. A pattern needs a version token and literal text, may not mix `{version}` with `{major}`, `{minor}` or `{patch}` (their values could disagree), and other tokens are `E_CONFIG`; a template on a plugin version file is `E_VERSION_FILE_CLAIM` (checked by `check` and when release files are built, since plugin `versionFiles` hooks run only then). A match (an edge that is a token or a letter or digit must not touch another letter or digit, so `@v{major}` matches in `org/repo@v1`; never followed by `.<digit>`) is replaced with the rendering of `next` when its values render a version `v` with `from <= v < next`, compared over the tokens present, so `run-v2` left by a stale merge still moves. A first release leaves templates alone; a missing file is `E_VERSION_FILE_MISSING`; a pattern with no match at all warns `W_VERSION_FILE_NO_MATCH` (a match already at `next` is silent). An entry without `pattern` uses version markers: on each line containing `# x-tallyrelease-version` or `<!-- x-tallyrelease-version -->`, the first word the unit's scheme parses (a leading `v` stays) is replaced with `next`, also on a first release; a file without a marked version warns `W_MARKER_NO_MATCH`. Markers carry no unit id, so a marker file of two units is `E_VERSION_FILE_CLAIM`. The node plugin writes `package.json`: `version`, and in `dependencies` and `optionalDependencies` the exact ranges (`1.2.3`, `=1.2.3`, `workspace:1.2.3`, prefix kept) of packages released together; other ranges and exact pins in `devDependencies` and `peerDependencies` stay; indentation, CRLF line endings and the trailing newline are kept.

**Stale recovery.** A stale merge (plan equality fails) leaves the release commit on main without tags. The next plan still uses the old base tag; the `chore(release)` commit causes no bump; version file writers set versions to the new `next` and the changelog writer replaces the untagged section. The next release PR therefore contains exactly one changelog section above the base tag and version files equal to the new plan.

**File deletions.** `releaseFiles` returns `deletes` next to `files`: the consumed files of `Change.files` (A.5) whose named units all release in the given items. `commitFiles` takes them as an optional `deletes` list and removes them from the temporary index with `git update-index --force-remove`; a missing path is a no-op, and equal input still gives an equal sha, so the push skip holds. Split release PRs of the units a file names never delete it, since no single release commit releases all of them. A stale merge of a release commit that deleted files loses their intent: the next plan no longer finds them, so the recovered release can bump lower and its changelog section lacks their entries.

**Release list.** `run --github-output` writes `releases`, one entry per release or prerelease to publish (fields in [`release-list.md`](release-list.md)). Releases come first (`plan.released` order: oldest release commit first, then plan unit order), then build prereleases in plan unit order, none for a unit released or cut at HEAD; a cut prerelease comes from `plan.released` with the releases. Every stable tag in range is emitted, also several of one unit, so no tagged version stays unpublished; `latest` marks the highest. `catchUp` and `latest` are those of `plan.released` (A.7.10); a build prerelease has `catchUp: false` and `latest: false`, and every `catchUp: false` entry belongs to a unit in the build set of the same run. `latest` is computed at run time from the local tags: "re-run failed jobs" reuses the outputs of the run, so re-running an old failed publish after a newer release of the unit would publish with `latest: true`. Prefer letting the next run re-emit the release (step 2).

Effects are idempotent and support `--dry-run`.

---

## Purity rules

Core stays free of I/O so that `computePlan()` is deterministic and testable. Enforcement has three layers:

- Lint (`packages/core/eslint.config.ts`): `src/**/*.ts` (except specs) may not import Node builtins (`fs`, `path`, `os`, `child_process`, `net`, `http`, `https`, `http2`, `dgram`, `dns`, `tls`, `worker_threads`, `cluster`, `process`, `vm`) or `@tallyrelease/cli`, and may not use the globals `process`, `fetch`, `require`, `Buffer`.
- Types: core `tsconfig.build.json` sets `"types": []`.
- Bundle check: `check:purity` (`tools/check-purity.mjs`) bundles `src/index.ts` with esbuild for `--platform=neutral`. Any Node builtin import fails, including imports pulled in by dependencies, which lint cannot see. It runs in turbo `check` and CI. `test/purity.spec.ts` proves the check fails on a `node:fs` import (`test/purity/violation.ts`).

Built-in plugins in `packages/plugins/src/**` (`@tallyrelease/plugins`) use the public API only. Lint there forbids Node builtins, `@tallyrelease/cli`, the same globals, and relative imports that leave `src/`; plugins import only `@tallyrelease/core` and other files of the package. `packages/plugins` runs `check:purity` on `src/index.ts` like core.

---

## Decisions

| #   | Decision                         | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| :-- | :------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1  | Naming                           | Product `tallyrelease`, npm scope `@tallyrelease`. Packages `@tallyrelease/core`, `@tallyrelease/plugins` and `@tallyrelease/cli` (bin `tallyrelease`). Config `tallyrelease.yaml`. Labels `tallyrelease: *`, release PR branches `tallyrelease/release/<branch>/shared` and `tallyrelease/release/<branch>/<item>`.                                                                                                                                                                                                                                                                                                                                                                                          |
| E2  | Second plugin                    | `php`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| E3  | Publish core separately          | Yes. The cli depends on it at runtime; plugin authors need its types and `./testing`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| E4  | Node engines                     | `>=24`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| E5  | Default `preMajor`               | `breaking: minor`, `feat: minor`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| E7  | Repo visibility and licence      | Public, Apache-2.0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| E8  | Release PR token                 | Plain `GITHUB_TOKEN` by default; `--token` overrides. PRs and tags created with `GITHUB_TOKEN` do not trigger workflows, so users who need checks on release PRs pass another token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| E11 | Release opt-in                   | Units are build-only unless `release: true` (per unit or `defaults.release`). Plugins declare the version source (`file`/`tag`), config decides releasability; `Unit.version` stays the single effective value. Unreleased units are absorbed into released dependents (A.7.6), a deliberate divergence from release-please. Alternatives rejected: flipping `version` to default `none`, plugin heuristics such as `!private`, a top-level selector list.                                                                                                                                                                                                                                                    |
| D9  | Release PR branches              | Always a leaf: the shared PR is `tallyrelease/release/<branch>/shared`, a separate PR `tallyrelease/release/<branch>/<item>`; the item name `shared` is reserved (`E_RELEASE_ITEM_NAME`). `releasePr: shared \| separate` per item (default `shared`); `E_RELEASE_PR_SPLIT_EDGE` guards patch-propagating edges between items in different PRs. A git ref cannot be both a file and a directory, hence no `tallyrelease/release/<branch>` next to separate branches.                                                                                                                                                                                                                                          |
| D10 | Reconcile placement              | In the `release` job, after `check` and `test`, so tags follow green CI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D11 | Prerelease numbers               | From the plan: `<next>-<build>.<N>`, `N` = first-parent commits since the line base, without one since and including the unit's introduction. Unique per commit, no registry lookup, never lower than release-please's count for the same `next` (without a line base, release-please counts unit commits since the introduction, a subset of the first-parent commits on squash histories).                                                                                                                                                                                                                                                                                                                  |
| D12 | Changelog writer                 | One writer in core in release-please format (`## [<version>](<compare>) (<date>)`, sections, entries); the owning plugin's `changelog` hook may replace a unit's section. The heading date is the UTC date the release PR is generated (injectable `clock`).                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D13 | Prerelease cuts                  | `channels: { build, cut }` (`channel` is a deprecated alias of `channels.build`, one minor). `cut` PRs on `tallyrelease/prerelease/<branch>/<leaf>` carry changelog sections at `<next>-<cut>.<K>`, `K = N(H)+1`. Reconcile checks the intent at `H` against `P` (`cutEquals`, ancestry, latest cut tag), then tags `M` and creates a non-latest GitHub prerelease whose body is rendered at `P`. Tags are records only, no version is derived from them. Rejected: exact `N(M)` prediction (stale whenever anything lands first), a dispatched cut (no review, write token on dispatch), tag counters (state read from tags).                                                                                |
| D14 | Build versions                   | `version` writes the prereleases of the build at HEAD into version files, templates and markers (no changelogs, no deletes), so built artifacts report the version `run` releases for the commit. It plans HEAD with a null base (no forge, no token), skips items whose plugin version files already hold `next` (a merged release PR) and needs the full history. Known gap: a never-released unit still at its initial version `1.0.0` counts as released at HEAD and keeps it instead of the beta. Previews of release files use `pr --dry-run`. Alternatives rejected: reading `package.json` at runtime (npm only), a `versionFiles` template on the cli version (templates match only `[from, next)`). |
| O2  | Token handling                   | The cli is token-agnostic (`--token` or `GITHUB_TOKEN`) and documents the permissions per command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| O3  | Release list and catch-up builds | Entries carry `catchUp` and `releaseSha`; catch-ups are built at `releaseSha`; publishers treat already-published as success; `latest` follows the git rule (A.9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| O4  | groundwork first release         | 1.0.0 is the first release done by tallyrelease: a fixed group without a base tag, explicit `defaults.initialVersion: 1.0.0`, no bootstrap sha.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| O5  | Templated version files          | Unit overlay `versionFiles: [{ file, pattern }]` beside plugin version files; matches in `[from, next)` are replaced; the version string stays `0.0.0` until the owner decides.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| O6  | release-please PRs at the switch | No automatic changes; closing open `release-please--*` PRs is a manual step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

---

## Risks and mitigations

| Risk                                                                                 | Mitigation                                                                                                                                                                                                                                                                                                                                        |
| :----------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Queued runs replaced by concurrency, under-building or losing releases.              | Build base takes `lastSuccess` when it is older than `before` (G13); every run reconciles all merged pending release PRs (E09); `plan.released` is derived from tags in `(base, HEAD]`, so failed publishes are re-emitted (E16).                                                                                                                 |
| Catch-up releases built from the wrong commit.                                       | `catchUp: true` + `releaseSha` in the release list; publishers build those entries from `releaseSha`.                                                                                                                                                                                                                                             |
| PR body or branch rewritten during merge.                                            | `releaseCommit` in marker, `pr.head.sha` check, re-read before push, `--force-with-lease` (E10 scenario).                                                                                                                                                                                                                                         |
| Repo forgets to opt units in; nothing releases.                                      | `check` lists released units; `W_NO_RELEASED_UNITS`.                                                                                                                                                                                                                                                                                              |
| Attribution surprises (shared root files).                                           | `globalInputs`, `ignore`, `unattributed`, `explain`.                                                                                                                                                                                                                                                                                              |
| Plugin contract churn after publishing core.                                         | `apiVersion` gate; `PreCtx.tags` and `GitReader` settled before 1; the `validate` and `changelog` hooks were added as optional hooks of API version 1.                                                                                                                                                                                            |
| Prerelease collisions.                                                               | Line-base `N` (R23); channel checks (R19, R27); force-push on line branches unsupported.                                                                                                                                                                                                                                                          |
| Line branch fast-forwarded to a branch that merged main in.                          | Unsupported, like force-push: the first-parent chain changes, so the line base and `N` can drop. Merge into line branches instead.                                                                                                                                                                                                                |
| Root of an untagged unit renamed.                                                    | The introduction moves to the rename, so `N` restarts. Documented, same class as fast-forwarding a line branch; a stable release resets the counter anyway.                                                                                                                                                                                       |
| Member removed from an untagged group.                                               | The group counts the max over its members, so `N` can drop when the oldest member leaves. Documented.                                                                                                                                                                                                                                             |
| Shallow clone.                                                                       | Every unit is introduced at the shallow boundary, the same class as `total` without a line base.                                                                                                                                                                                                                                                  |
| Maintenance branch cut before any tag.                                               | It shares main's introduction; not a regression, as both count from the same commit.                                                                                                                                                                                                                                                              |
| Duplicate publish on workflow rerun.                                                 | Same version recomputed; publishers treat "already published" as success.                                                                                                                                                                                                                                                                         |
| Hidden I/O in core dependencies.                                                     | `check:purity` neutral bundle in CI.                                                                                                                                                                                                                                                                                                              |
| Release PR checks never run (`GITHUB_TOKEN` events).                                 | Documented; users who need checks pass another token with `--token`.                                                                                                                                                                                                                                                                              |
| tallyrelease releasing itself breaks.                                                | CI uses the previous published version.                                                                                                                                                                                                                                                                                                           |
| Lost or duplicate releases during the switch.                                        | `E_TAG_EXISTS` on a different sha; same-sha tags are a no-op, so a release-please tag at the same commit is harmless.                                                                                                                                                                                                                             |
| Release merge with failing tests is published later from its own sha.                | Documented; fix forward with a new release; `release-build` builds the tagged content.                                                                                                                                                                                                                                                            |
| Separate and shared PRs publish inconsistent pins or dependency releases.            | `E_RELEASE_PR_SPLIT_EDGE`.                                                                                                                                                                                                                                                                                                                        |
| Re-running an old run rolls a deployment back or regresses open PRs.                 | Git rule for `latest` (A.9); `W_PR_HEAD_BEHIND` is evaluated first.                                                                                                                                                                                                                                                                               |
| A replaced queued release run leaves its release undeployed.                         | Catch-up entries that are the newest version of their unit are dispatched.                                                                                                                                                                                                                                                                        |
| Two versions of one unit in one list break name-keyed publishers.                    | Every version is published; `version_map` per artifact in `publish-npm`; `publish-linear` keeps the highest per access key.                                                                                                                                                                                                                       |
| Re-run of an old failed publish takes `latest` after a newer release.                | Documented; the next run re-emits failed releases with a fresh `latest`.                                                                                                                                                                                                                                                                          |
| A merged release PR not yet visible lets a run succeed past it.                      | The issues API label listing is not search-indexed, and `released` is united with this run's reconciled tags; fallback guard on a positive signal if it ever happens.                                                                                                                                                                             |
| A run stays red on `E_BASE_REQUIRED`.                                                | Recovery in [`ci.md`](ci.md).                                                                                                                                                                                                                                                                                                                     |
| A forge error yields a null base and drops failed publishes.                         | `E_BASE_REQUIRED` in `release` and `run`.                                                                                                                                                                                                                                                                                                         |
| Broker-token tags and release PRs trigger more workflows than before.                | Release-please parity.                                                                                                                                                                                                                                                                                                                            |
| A prerelease published by release-please has the same version as a new plan version. | Squash repos cannot collide.                                                                                                                                                                                                                                                                                                                      |
| Token scopes or rulesets block tag or branch pushes.                                 | Permissions per command in [`ci.md`](ci.md).                                                                                                                                                                                                                                                                                                      |
| Separate PR churn (one force-push per open PR per push).                             | Accepted, release-please parity.                                                                                                                                                                                                                                                                                                                  |
| Duplicate `Authorization` header when checkout persisted credentials.                | Header reset before the token header is set; `persist-credentials: false` recommended.                                                                                                                                                                                                                                                            |
| Prerelease numbers change visibly (D11).                                             | The new `N` is never lower for the same `next`; documented.                                                                                                                                                                                                                                                                                       |
| OCI tags overwritten or rejected on re-run.                                          | Existence probe on `<image>:<version>` in `publish-oci`.                                                                                                                                                                                                                                                                                          |
| Squash commit body carries footer-like lines.                                        | Release commit body lines never start with `Token:`; the marker is an HTML comment.                                                                                                                                                                                                                                                               |
| Historical releases re-emitted without a base.                                       | `W_RELEASED_NO_BASE`, HEAD-only.                                                                                                                                                                                                                                                                                                                  |
| `release-build` is a second build path at an arbitrary sha.                          | Same anchored steps as `check` except its own checkout at `matrix.sha`; the sandbox run checks the tarball version.                                                                                                                                                                                                                               |
| Changelog order differs from release-please.                                         | Byte parity checked on real history.                                                                                                                                                                                                                                                                                                              |
| Stale cut PRs, `K` below `N(M)` under merge queues, label rename collisions.         | Keep rule and `cutEquals` at `H` against `P`; `K` stays unique and increasing per label and `next`. After a rename `previousCut` falls back to `baseTag` and a build can equal an old cut tag. A legacy tag with the same label and `next` can collide with `K` (`E_TAG_EXISTS`): adopt cuts with a fresh label or after the next stable release. |

---

## ADR

**Decision.** Build `tallyrelease` as two packages (pure `core`, imperative `cli`) with a versioned plugin contract from day one. Core reads files and git only through injected `ReadonlyFs` and `GitReader`. Ship build selection (`affected`) first, then the versioning planner, then effects (release PR, tags, floating tags, forge releases) and the switch. Built-ins `node` and `php` use only the public API. Every run reconciles from durable facts (tags, first-parent history, PR state).

**Drivers.** Migration risk for existing consumer repos; determinism and testability; reaching PHP/Flutter without core changes.

**Alternatives considered.** single package; full planner first; `generic` as second plugin (resolved by config-only units with `versionFiles`); cli-side hook invocation with precomputed git facts; green refs for build base; `before`-only build base; attributed-commit or reachable-base prerelease counter; commit trailers and input hash for merge detection; HEAD-only merge detection; strict first-parent stale check; label-driven publishing; absolute branch-pattern caps.

**Why chosen.** Two packages give a hard purity boundary at minimal cost, backed by lint, `types: []` and a neutral bundle. `GitReader` injection makes `computePlan()` one call and lets scenarios describe real DAGs. `affected` first delivers build selection with zero versioning risk. `php` stresses tag-only versioning. Durable reconciliation (lastSuccess vs `before`, merged-pending PR lookup, `releaseCommit` and plan-equality checks, `plan.released` from tags) survives cancelled runs, merge queues, races and failed publishes. Line-base `N` stays monotonic across maintenance merge-backs; relative limits keep monorepo maintenance lines usable.

**Consequences.** Core is async; `memoryGit` must model first-parent ancestry. Two integration passes in `abinnovision/actions`, plus a publisher change for `catchUp` entries. Every push run makes one forge call for the base. cli is a large package until split. Each repo switches from release-please on its own.

**Effects addendum.** Effects live in the cli over pure core pieces (changelog writer, release items, marker). Release commits are built on a temporary index without a checkout (identity from `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, default `tallyrelease <tallyrelease@users.noreply.github.com>`; HEAD's committer date) and pushed with `--force-with-lease`. Release PR branches are always leaves (D9). Tags are the record of releases; `plan.released` comes from tags in `(build.base, HEAD]`. Entries not built at HEAD are built at `releaseSha`, and `latest` follows the git tags (A.9). Rejected: schema 2 with per-publisher catch-up builds, catch-ups built from HEAD, a `--` branch separator, marker v2, reconcile in `configure` or on `pull_request: closed`, assembling the list in jq, a checked-out release branch, GraphQL `createCommitOnBranch`, registry lookups for `latest` or prerelease numbers.

**Shadow removal addendum.** `shadow` served the switch from release-please and was removed in cli 0.5; its codes stay documented as retired.

**Prerelease cut addendum.** Decision: a branch rule has `channels: { build, cut }`; `build` is the per-push untagged prerelease, `cut` a hand-cut prerelease through `tallyrelease/prerelease/<branch>/<leaf>` PRs at `<next>-<cut>.<K>` with `K = N(H)+1`, tagged and published as a non-latest GitHub prerelease on merge. Drivers: correctness under merge queues and busy mains, config that shows what happens on push and on merge, a small diff over the release PR machinery (`releaseItems`, `planEquals`, `released`, catch-ups). Alternatives: `channel` plus a `prerelease` key, `prerelease: { build, cut }`, `channel` plus `cut`, a PR that predicts `N(M)`, `run --cut` dispatch, tag counters. Consequences: a review surface and no dispatch token, at the cost of changelog churn and cut numbers not tied to `M`; one noun (channel) everywhere. Follow-ups: rolling per-push releases, pruning of old cut sections and tags, removal of the `channel` alias in the next minor.

**Follow-ups.** Linked groups; SEA binary; release-please importer; SchemaStore registration for `tallyrelease.yaml` (the schema is already published).
