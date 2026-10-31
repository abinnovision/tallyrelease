# tallyrelease: design

Status: v0.3 (effects: version files, release PRs, tags, forge releases); v0.4 is in progress (release list for publishers). This repo releases itself with tallyrelease since 0.3.1 (v0.3 task 6 done). Packages: `@tallyrelease/core` (pure planning core) and `@tallyrelease/cli` (binary `tallyrelease`). Config file: `tallyrelease.yaml`. Labels: `tallyrelease: pending` / `tallyrelease: released` / `tallyrelease: stale`. Release PR branches: `tallyrelease/release/<branch>/shared` and `tallyrelease/release/<branch>/<item>`. PR marker: `<!-- tallyrelease-plan:v1 ... -->`. Error codes `E_*`, warning codes `W_*`.

Core function names: `loadWorkspace()` in `workspace.ts` (plugin hooks, units and graph), `computeAffected()` in `affected.ts`, `computePlan()` in `plan.ts`. Plugin hooks keep the short names `discover` and `edges`.

## A. Design

### A.1 Summary

`tallyrelease` reads git history, conventional commits and a dependency graph supplied by ecosystem plugins, and computes:

- the **build set** (what this push affected, including dependents), from v0.1;
- the **release set and versions** per branch line, from v0.2;
- release PRs, tags (including floating tags) and forge releases as effects, from v0.3.

It replaces `run-release-please` in `abinnovision/actions`. Building and publishing stay with the stacks and publishers.

### A.2 Goals and non-goals

Goals: ecosystem-agnostic core; commit-driven intent; path-based attribution; separate build and release sets; deterministic prereleases with no committed state; maintenance lines; versioned plan output; runs locally and in any CI (GitHub first); pure, fixture-tested core; correctness under cancelled or reordered CI runs.

Non-goals: building, packaging, publishing; forward-porting hotfixes; AI or heuristic release notes; replacing turbo/Nx/moon; scope-based attribution in v1; plugin distribution (local `.ts` plugins, npm plugin packages) in v1; effects and changelog as plugin hooks in v1.

### A.3 Concepts

| Term            | Definition                                                                                                                                                                                                       |
| :-------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | Buildable, optionally released thing: `id`, `root`, `include`/`exclude`, effective `version` (`file` \| `tag` \| `none`), `scheme`, `tagFormat`, `propagate`, owning `plugin`, namespaced `meta`.                |
| Released unit   | Unit opted in by config (`release: true` or `defaults.release: true`). Its `version` is the version source (`file` or `tag`, from the plugin unless overlaid). Every other unit is build-only (`version: none`). |
| Version source  | Where a released unit's version lives: `file` (tags and version files) or `tag` (tags only). Declared by the plugin; config decides whether the unit is released.                                                |
| Edge            | `from -> to`: `to` depends on `from`. `pinned` is true when `to`'s published manifest must change when `from`'s version changes.                                                                                 |
| Global input    | Repo file whose change marks **all** units affected for the build set and is **never** attributed for releases (lockfiles, `tallyrelease.yaml`, root `tsconfig*.json`, `turbo.json`).                            |
| Ignore          | Glob dropped before any processing (build and release).                                                                                                                                                          |
| Change          | One unit of intent (normally a parsed commit) attributed to units.                                                                                                                                               |
| Line            | `default` or `maintenance`. A maintenance rule limits bumps (A.7.9).                                                                                                                                             |
| Channel         | Prerelease label, set per branch rule. No channel, no prereleases.                                                                                                                                               |
| Base tag        | Highest stable tag of a unit reachable from HEAD. Source of `from`.                                                                                                                                              |
| Line base       | Highest stable tag of a unit on HEAD's first-parent chain. Origin of the prerelease counter; without one, the unit's introduction.                                                                               |
| Build set       | Units owning files changed in `base..HEAD`, plus reverse-transitive dependents and the mates of affected group members; all units if a global input changed.                                                     |
| Release set     | Released units with a pending bump since their base tag, including Changes absorbed from unreleased dependencies (A.7.6), after propagation and fixed groups.                                                    |
| Group           | Fixed group (A.7.8): released units selected by `units` or `tags` that release together with one version. Tags and changelogs stay per unit.                                                                     |
| Release item    | Ungrouped released unit or fixed group; releases as one. `releasePr` puts it in the shared release PR (`shared`, default) or its own (`separate`). The name `shared` is reserved.                                |
| Initial version | Version of a unit's first release (`initialVersion`, else the scheme's initial version).                                                                                                                         |
| Plan            | `plan.json` (schema 1). `affected.json` (schema 1) is the v0.1 subset.                                                                                                                                           |

### A.4 Architecture

```
                cli (imperative shell)                               core (pure)
 tallyrelease.yaml ──> config/load (zod) ────────── TallyConfig ─────┐
 fs ──────────> fs-ctx (node:fs, tinyglobby) ─ Ctx/ReadonlyFs ─┤
 git ─────────> git/reader (execFile git) ──── GitReader ──────┼──> loadWorkspace() (units, graph)
 plugins/node, plugins/php (public API only) ─ Plugin[] ───────┤    computeAffected()   (v0.1)
 GITHUB_* env + Forge ─> ci/base (build base) ─ BuildBase ─────┘    computePlan()       (v0.2)
 Forge (Octokit) <── effects (v0.3: reconcile, release-pr, tags, forge-release) <── Plan
 stdout / $GITHUB_OUTPUT / files <── outputs
```

Sequence per run (v0.3 shape; earlier milestones stop early):

1. cli loads config and plugins, builds `Ctx` and `GitReader`, runs `loadWorkspace()` (reconcile needs units, tag formats and schemes), resolves the build base (A.7.5).
2. cli reconciles merged release PRs (A.12): tags are created locally and pushed, then the reader's tag cache is invalidated.
3. core `computePlan()` runs graph, build set, release set, versions and `released` in one call. (`computeAffected()` is the v0.1 subset.)
4. cli runs the `release-pr` effect and writes outputs.

Plugin hooks are awaited sequentially in config order (never `Promise.all`), so warnings and merged output are deterministic. Planning at a historical commit (`plan --head`, shadow, reconcile) uses one cli helper, `planAt(ref)`: `tallyrelease.yaml` is read and validated from the working tree, then files come from a git-backed `ReadonlyFs` at the ref (paths listed once with `git ls-tree -r -z --name-only`, blobs read lazily with `git cat-file blob` and cached; a path absent at the ref reads as absent, any other git failure, such as a blob a partial clone cannot fetch, throws `E_GIT_READ` instead of reading as absent), then `computePlan()`. Nothing is checked out, so no hooks, LFS smudge filters or cleanup are involved. Injected runs pass `deps.fsAt(ref)` instead.

Effects (v0.3) go through two cli seams. `Forge` lists release PRs through the issues API (label `tallyrelease: pending`, then one PR read each for head, merge and body; no search index lag), creates, updates and closes PRs (closing comments), sets the one `tallyrelease:` label (creating missing labels, optional comment), and looks up branch heads, the PR of a merge commit and releases by tag; it creates releases. `GitWriter` builds release commits on a temporary index (`read-tree`, `hash-object -w --no-filters`, `update-index --cacheinfo`, `write-tree`, `commit-tree` with `-c commit.gpgsign=false`), so the working tree, index and HEAD stay untouched. Author and committer are `tallyrelease <tallyrelease@users.noreply.github.com>` and both dates equal the given date (HEAD's committer date), so equal input gives an equal sha. Tags are written with `update-ref` (no-op at the same sha, `E_TAG_EXISTS` elsewhere unless forced). Pushes go to `origin` with `--force-with-lease` per ref (empty expected value when the ref must not exist; a failed lease is `E_PUSH_LEASE`) and optionally `--atomic`. With a token, the push resets `http.<origin>/.extraheader` and sets `AUTHORIZATION: basic <base64(x-access-token:<token>)>` through `GIT_CONFIG_*` variables, so persisted checkout credentials are replaced and the token never appears in argv or debug output. The reader caches no tags, so tags written by a run are visible to its next `planAt`.

Purity enforcement: lint rule (see Purity rules) on `packages/core/src/**` and `packages/cli/src/plugins/**`; core `tsconfig.build.json` sets `"types": []`; core `check:purity` bundles `src/index.ts` with esbuild `--platform=neutral` and fails on any Node builtin, including transitive dependency imports (see Purity rules).

### A.5 Plugin contract (`@tallyrelease/core`)

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
  tagFormat?: string; // default A.10
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
  // read in v0.2, write in v0.3
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
    input: { from: string | null; to: string; commits: readonly RawCommit[] },
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
  notes?: string; // BREAKING CHANGE footer text (v0.3)
  releaseAs?: { unit?: string; version: string }[]; // Release-As footers; unit from the qualified form <unit>@<version>
  pr?: number;
  date?: string;
}
```

Core built-ins (expressed through the contract, registered as internal plugin `core`): scheme `semver` (v0.2), intent source `conventional-commits` (v0.2, a small in-core parser exported as `parseCommit(message)`: header `type(scope)!: subject`, trailing `(#123)` as `pr` (also for non-conventional headers, which yield `type: ""`). Footers follow Conventional Commits: the footer block starts at the first paragraph whose first line is `Token: value` or `Token #value`, and a value runs, possibly over several lines, until the next such line. They are kept as `footers: Record<lowercased token, string[]>`; uppercase `BREAKING CHANGE`/`BREAKING-CHANGE` set `breaking`. Each commit maps to exactly one Change; the first line of each `Release-As` value becomes a `Change.releaseAs` entry (`<unit>@<version>` names a unit, a plain value applies to the units the Change is attributed to); no synthetic Changes. The plugin name `core` is reserved. No `conventional-commits-parser`, whose v7 imports `stream` and fails `check:purity`), default global input `tallyrelease.yaml`.

Commit order: `log` returns commits in any order (the cli reader uses `--topo-order`, `memoryGit` reverse declaration order; conformance checks that every commit is listed before its parents). Core never relies on it: every order-dependent rule sorts commits by committer date descending, compared as instants (`Date.parse`, since `%cI` carries offsets), then by sha ascending.

Other pure exports (v0.3, A.12): `releaseFiles(workspace, plan, { fs, items, repoUrl, date })`, which also returns the changelog sections; `releasedFromTags(workspace, plan, { git, tags })`, whose entries carry `floatingTags`; `encodeMarker(marker)` and `decodeMarker(body)`; `releaseItems(workspace, plan)`, `releaseEntries(items)` and `planEquals(marker, plan, workspace)`; `maintenanceCut(workspace, plan, item)`; `compileTagFormat(format, unitId)` and `renderTag(unit, version)`, for plugins that emit tag formats. `./testing` exports `memoryFs`, `memoryCtx` and `memoryGit`. `./testing/conformance` (requires vitest) exports the shared spec suites `gitReaderConformance(makeReader)`, run against `memoryGit` (core unit tests) and the real cli reader (cli integration), and `schemeConformance(scheme)`, run against `semver` and the flutter sketch. Both `GitReader` implementations agree on ancestry, first-parent counts, tag peeling and rename handling.

**Flutter scheme sketch (paper only, validates the interface):**

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
  Math.max(
    ctx.firstParent.total + Number(ctx.unit.meta["dart"]?.["buildOffset"] ?? 0),
    highestTaggedBuild(ctx.tags) + 1,
  );
```

Findings folded into the contract: stable versions also need git data (`release(next, ctx)`); limits and pre-1.0 rules need a numeric core (`core()`); prerelease detection is scheme-specific (`isPrerelease`); build numbers must stay above every **tagged** build including tags not reachable from HEAD, because `firstParent.total` on a maintenance branch can be lower than on `main` (`PreCtx.tags`). Known limitation: untagged prerelease builds are invisible to every other line, so teams uploading prereleases from `main` to Play need a CI-run-number build source; that belongs to the `dart` plugin and is deferred.

### A.6 Hook conflict rules

| Hook           | Called                                                    | Merge rule                                                                                                                                                                                                                                                                                                                                                                                                                                       | Conflict result                                                                                                                                                                                                             |
| :------------- | :-------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discover`     | Every enabled plugin, config key order                    | Concatenate. Core sets `unit.plugin`, stores `meta` at `meta[plugin.name]`. Then config `units.<root>` overlays apply field by field (overlay wins); a key containing `*` is a glob over unit roots (A.7.1). `release` comes from config only, so a plugin cannot opt a unit in. An overlay at a root with no discovered unit **always creates** a config-only unit (`plugin: "config"`); its `id` defaults to `defaultUnitId(root, repo.name)`. | Same `id` twice: `E_DUPLICATE_UNIT` (names both owners). Same `root` from two plugins: `E_DUPLICATE_ROOT`. Invalid glob key or glob field: `E_UNIT_GLOB`.                                                                   |
| `edges`        | Every enabled plugin, plus config `deps`                  | Union, dedupe by `(from,to)`: `pinned = OR`, `reasons` and `sources` unioned and sorted.                                                                                                                                                                                                                                                                                                                                                         | Unknown unit id: `E_EDGE_UNKNOWN_UNIT`. Self edge: `E_EDGE_SELF`. Cycles allowed (`W_CYCLE` with path); closure and propagation are cycle-safe.                                                                             |
| `inputs`       | Every enabled plugin                                      | Union of plugin `global`, core `tallyrelease.yaml`, config `globalInputs`. `plugins.<name>.globalInputs: false` disables that plugin's defaults; core strips this key before validating plugin `options`.                                                                                                                                                                                                                                        | None (union).                                                                                                                                                                                                               |
| `versionFiles` | Owning plugin, per owned `file` unit, lazily              | Config overlays may add templated text files (`units.<root>.versionFiles`, A.10); templates may share a file.                                                                                                                                                                                                                                                                                                                                    | A plugin path claimed by two units, or a template on a plugin path: `E_VERSION_FILE_CLAIM` (`validateRelease`).                                                                                                             |
| `schemes`      | Registry built at load                                    | Name -> scheme. `semver` is reserved by core.                                                                                                                                                                                                                                                                                                                                                                                                    | Raised by `validateRelease` (`check`, `computePlan`), never by `affected`. Duplicate name: `E_SCHEME_CLASH`. Unknown scheme of a released unit: `E_SCHEME_UNKNOWN`. Group members with different schemes: `E_GROUP_SCHEME`. |
| `intent`       | All sources of enabled plugins, per distinct commit range | Concatenate Changes. Per unit: bump = max. Commit-derived Changes deduped by `sha,type,breaking`, plus explicit `units`.                                                                                                                                                                                                                                                                                                                         | Release-As problems warn (history cannot be edited): different values for one unit, newest commit wins (`W_RELEASE_AS_CONFLICT`); see A.7.6 step 6.                                                                         |
| `options`      | At load                                                   | Validated against `plugins.<name>` minus core-owned keys (`globalInputs`). `path` is owned by the cli, which loads the plugin from that file and strips the key before core reads the config.                                                                                                                                                                                                                                                    | `E_PLUGIN_OPTIONS` with schema issues.                                                                                                                                                                                      |

Hook rules: hooks are awaited one at a time in config order; inputs are frozen in dev/test; hooks must be deterministic for equal inputs; thrown errors are wrapped as `E_PLUGIN_HOOK` with plugin and hook name. Effects and changelog rendering are not plugin hooks in v1 (both additive later).

### A.7 Core algorithm

**A.7.1 Discovery.** As in A.6. Default `include` = `["<root>/**"]` (`["**"]` for `.`); default `exclude` = roots of units nested inside this unit (deepest root wins). Explicit `include` replaces the default; explicit `exclude` is appended. Effective version: `released = overlay.release ?? defaults.release ?? false`; `version = released ? (overlay.version ?? draft.version ?? "tag") : "none"`. An overlay `version` on an unreleased unit is allowed and takes effect once the unit is released; config-only units follow the same rule. Ids match `/^(?!\.\.?$)[A-Za-z0-9._-]+$/` (`E_UNIT_ID`); overlay `tags` match `/^[A-Za-z0-9._-]+$/` (`E_UNIT_TAG`) and are sorted and deduplicated; roots are normalized (`.` and empty segments dropped), must be repo-relative without `..` segments (`E_ROOT_INVALID`) and must exist (`E_ROOT_MISSING`). A root unit with `include: **` absorbs every file not owned by a nested unit, so `unattributed` stays empty in such repos; global inputs are still checked first, so a root `package.json` change remains global (deliberate over-build).

A `units` key containing `*` is a glob over unit roots. `*` matches exactly one path segment and never a segment starting with `.`; other segments match literally (`[x]` stays literal); pattern and root need the same segment count (`apps/*` does not match `apps/web/sub`). `**` or a partial star like `web-*` is `E_UNIT_GLOB`. Order: exact keys first create config-only units, then globs apply in declaration order to discovered and config-only units field by field (a later glob wins), then exact overlays merge last and win per field; `tags` replace, never union. Globs cannot set `id`, `include`, `exclude` or `versionFiles` (`E_UNIT_GLOB` with `key` and `field`; the cli zod schema rejects the four fields on glob keys with the same message), never create units, never raise `E_ROOT_MISSING`, and warn `W_UNIT_GLOB_UNMATCHED` when they match nothing.

**A.7.2 Graph.** As in A.6. Reverse adjacency precomputed; closure is BFS with a visited set. Topological order (used for propagation and the release list): Tarjan SCCs in dependency order, members of a cycle ordered by id.

**A.7.3 Attribution (path-based only).** A path belongs to every unit whose `include` matches and `exclude` does not (`picomatch/posix` v4, `dot: true`). Commit file lists use `--no-renames`, so renames count for both old and new path. In the release set (A.7.6) a commit without files (`git commit --allow-empty`) is attributed to every released unit, as release-please does; the build set is unchanged, since such a commit changes no files. Scope narrowing/forcing is deferred.

**A.7.4 Build set (v0.1).**

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

Group coupling (v0.2): if any member of a fixed group is affected, all members are, so every unit that gets a version is built; a coupled member's dependents are affected too. Reasons are assigned after the closure with precedence `direct` > `dependent` > `group`. `affected --tag` filters after coupling, so a mate without the tag is dropped from the filtered output. Repos without `groups` are unchanged. Structural group errors (`E_GROUP_UNKNOWN_UNIT`, `E_GROUP_OVERLAP`) fail `affected`; release-only group errors do not.

A released unit owns `<root>/CHANGELOG.md` (`changelogPath`; `CHANGELOG.md` for a root unit) regardless of `ignore`, `include` and `exclude`, with reason `direct`; global inputs are still checked first. So a release commit always keeps its units in the build set, tag-only units under `ignore: ["**/*.md"]` included. `explain` lists that changelog among the unit's files.

Tree-to-tree diff needs no special casing for merges, reverts or squash merges. Unreleased units (`version: none`) are included; build selection depends on release status only through changelog ownership. Output sorted by unit id.

**A.7.5 Build base resolution (cli, in order).**

| #   | Event                                                  | Rule                                                                                                                                                                                                                                                                                                                                                                      | `baseSource`                          |
| :-- | :----------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------ |
| 1   | any                                                    | `--base <ref>`; must resolve, else `E_BASE_UNRESOLVED`.                                                                                                                                                                                                                                                                                                                   | `cli`                                 |
| 2   | push, `before` usable (not all-zero, ancestor of HEAD) | Look up `lastSuccess` (row 4 query). If `lastSuccess` is an ancestor of (or equal to) `before`, use it; else use `before`. Without token: `before` plus `W_NO_FORGE`. Token present but no `lastSuccess` (first adoption, renamed workflow, all runs failed): `before` plus `W_NO_LAST_SUCCESS`. Never builds less than `before`, and covers runs cancelled while queued. | `forge-last-success` or `push-before` |
| 3   | pull_request / merge_group                             | `merge-base(HEAD, pull_request.base.sha)`; `merge_group.base_sha`.                                                                                                                                                                                                                                                                                                        | `pr-merge-base` / `merge-group`       |
| 4   | push with unusable `before`, dispatch, schedule        | `lastSuccess`: workflow path from `GITHUB_WORKFLOW_REF`; `GET /repos/{o}/{r}/actions/workflows/{file}/runs?branch=<b>&status=success&event=push`; first `head_sha` that exists locally and is an ancestor of HEAD.                                                                                                                                                        | `forge-last-success`                  |
| 5   | no `GITHUB_EVENT_NAME`, no CI detected                 | `merge-base(HEAD, ref)` with `ref` from `origin/HEAD`, else the first of `origin/main`, `origin/master`, `main`, `master` that resolves. No ref or no merge base: row 6. Never `E_SHALLOW_BASE`.                                                                                                                                                                          | `local-merge-base`                    |
| 6   | fallback                                               | `base = null`, everything affected.                                                                                                                                                                                                                                                                                                                                       | `none`                                |

CI is detected when `CI` is set to anything but empty, `false` or `0`, or when any of `JENKINS_URL`, `TF_BUILD`, `CODEBUILD_BUILD_ID`, `BUILDKITE`, `GITLAB_CI`, `TEAMCITY_VERSION` or `BITBUCKET_BUILD_NUMBER` is set; detected CI without a GitHub event and unknown GitHub events use row 6. Locally (row 5), `affected` answers "what did my branch change versus the default branch": on the default branch with nothing unpushed the base is HEAD and no unit is affected. Uncommitted changes are not included.

A base sha named by the event, flag or forge that is missing locally while `git rev-parse --is-shallow-repository` prints `true` is `E_SHALLOW_BASE` (exit 1), never "everything".

When the last successful run cannot be looked up, the base falls back to `before` (row 2) or to everything (rows 4 and 6) and the document carries a warning: `W_NO_WORKFLOW_CONTEXT` if `GITHUB_REPOSITORY`, `GITHUB_WORKFLOW_REF` or `GITHUB_REF_NAME` is missing, `W_FORGE_ERROR` if the forge request fails.

**A.7.6 Release set (v0.2).** For each released unit (`version != none`):

1. **Tag matching:** `tagFormat` compiles to an anchored regex: literal parts and `{id}` are regex-escaped, `{version}` must occur exactly once (else `E_TAG_FORMAT`), becomes `(.+)` and must parse with the unit's scheme. A unit's tags are sorted by `compare`, ties broken by tag name (semver ignores build metadata for precedence). `check` and `computePlan()` fail with `E_TAG_FORMAT_OVERLAP` if two released units render the same format, or if any existing tag parses for more than one released unit. Unreleased units are never matched, so units sharing a format such as `v{version}` never fail `check` while unreleased.
2. **Base tag:** max by `compare` over `git.tagsMerged(head)` for the unit, prereleases skipped. **Line base:** highest such tag whose commit `isFirstParentAncestor(tag, head)`; may differ from the base tag after a maintenance branch is merged back. `sinceLineBase = countFirstParent(lineBase, head)`; lineBase null: from the unit's introduction, `countFirstParent(introduced, head) + 1` with `introduced = git.introduced(root, head)` (the oldest first-parent commit whose diff to its first parent touches the root, so the introducing commit gets 1; a unit added on a side branch is introduced by the merge). A root unit (`.`) and a unit no commit introduces count `total = countFirstParent(null, head)`.
3. **Commits:** `git.log(baseTag, head)` (no merges; group members use the group base tag, A.7.8), in core commit order (A.5); intent sources run once per distinct range. Files minus `ignore` minus `globalInputs`, then attribution; a Change with `units` is attributed to those units; lockfile-only commits never bump. The unit's Changes are those attributed to `{R} ∪ reach(R)` (absorption, below); each commit counts once.
4. **Own bump:** max over attributed Changes via `bumps.types` (merged over the defaults `feat: minor`, `fix`/`perf`/`revert: patch`; breaking: major, whatever the type). If `core(from).major == 0`: breaking changes use `preMajor.breaking` (default `minor`) and changes whose type level is `minor` use `preMajor.feat` (default `minor`), so `bumps.types: { feat: patch }` stays `patch`. The `preMajor.breaking: minor` default differs from release-please's default (`bump-minor-pre-major: false`, breaking gives `major`); repos relying on that default set `preMajor.breaking: major`, and remaining differences are labelled `release-config` in shadow.
5. **From version:** the base tag version. Without a base tag (first release) `from` is `null` and `next = releaseAs ?? initialVersion` (unit overlay, else `defaults.initialVersion`, else `scheme.initial()`); commits since the root decide only whether the unit is pending. An initial version that does not exceed the unit's highest prerelease tag warns `W_INITIAL_BELOW_PRERELEASE`. A repo whose history predates its tags adopts tallyrelease by pushing a baseline tag (for example `core-v1.4.0` on the last release commit).
6. **Release-As:** a footer value applies to the units its commit's Change is attributed to; the qualified form `<unit>@<version>` applies only to the named unit and adds no bump or change entry for it. Within one commit a qualified value beats a plain one for that unit. A single leading `v` is stripped before parsing (release-please parity). For an ungrouped unit the value overrides `next`, even below the computed bump; it must parse as a stable version (prerelease values such as `2.0.0-rc.1` are rejected) and exceed `from`, else it is ignored with `W_RELEASE_AS_INVALID`. Different values for one unit: the newest commit in core order wins, `W_RELEASE_AS_CONFLICT`. Unknown unit: `W_RELEASE_AS_UNKNOWN`. A qualified value naming an unreleased unit, or a plain value on a commit attributed to no released unit: `W_RELEASE_AS_IGNORED`. Footers are not absorbed. All Release-As problems warn, because history cannot be edited.

A unit is pending when it has a bump or a Release-As value; `next` is `null` otherwise. Unreleased units are never pending. No released unit while a branch rule matches: `W_NO_RELEASED_UNITS`. A released unit without a matching tag while some tag contains its id (delimited by non-alphanumeric characters): `W_NO_MATCHING_TAG`, a hint at tag format drift.

**Absorption (unreleased units are transparent to released dependents).** For a released unit `R`, `reach(R)` is the set of unreleased units found by a reverse walk over edges (any edge, pinned or not) starting at `R`'s dependencies, with a visited set, never stepping into or through a released unit. Cycles among unreleased units terminate through the visited set. Absorbed Changes contribute a level only when their own level (type mapping, or breaking) is set, so `chore:` gives nothing. With `bumps.absorbed: patch` (default) that level is `patch` for every such Change, `feat` and breaking included; with `minor` it is the own level capped at `minor` (`fix` patch, `feat` and breaking minor). An absorbed Change never bumps `R` by major, because it breaks in-repo callers, not `R`'s consumers (a real break of `R` is a commit attributed to `R` or `Release-As`). A commit touching an absorbed unit and `R`, or reaching `R` by two paths, is one Change. Absorption reads `R`'s own range (since `R`'s base tag). In the plan, `absorbedFrom` lists the absorbed units of `R`'s Changes not attributed to `R` itself, and each such Change carries `via`, the first of its absorbed units by id. Example: a `fix:` or `feat:` in an unreleased `packages/db` patches every released app that depends on it, directly or through other unreleased units; a `chore:` in `packages/tsconfig` reaches the apps and bumps nothing.

**A.7.7 Propagation (v0.2).** Fixpoint over edges in topological order (terminates: bumps only increase). For `from -> to` where `from` has a bump, policy = `to.propagate`, with `auto = pinned ? patch : rebuild`. `from` has a bump when it is pending (own or absorbed bump, Release-As, or a bump raised by propagation). `patch` raises `to` to at least `patch` and adds `from` to `propagatedFrom` (sorted); a raised unit is pending and a propagated patch is a pending bump for kinds (A.7.10). Cycle members can patch each other. `rebuild` changes nothing in the release set. Propagation onto an unreleased dependent is a rebuild only. A propagated patch onto a released unit without a base tag is its first release (`next` = initial version, A.7.6 step 5). For an ungrouped unit, Release-As stays the explicit target: propagation raises its `bump` and lists the source, but `next` is the Release-As value. Group raising runs in the same fixpoint: a group with a pending member makes every member pending at the members' max bump, so a raised member propagates to its dependents and a propagated patch on one member raises its group.

Propagation through unreleased units: a released `R1` that reaches a released `R2` only through unreleased units is treated as a direct edge `R1 -> R2`, with `pinned` taken from the first hop (`R1 -> U`), the hop that changes `U`'s shipped content. With several paths or an additional direct edge, the first-hop `pinned` values are OR-combined, as in edge dedupe (A.6). Example: `core` (released) feeds `adapter` (unreleased) feeds `app` (released); a `fix:` in `core` releases `core` and propagates to `app` per its policy.

Node pinning:

| Field                  | Exact version, `workspace:*`, `workspace:x.y.z` | `^`, `~`, `workspace:^`, `workspace:~`, other ranges |
| :--------------------- | :---------------------------------------------- | :--------------------------------------------------- |
| `dependencies`         | pinned                                          | not pinned                                           |
| `optionalDependencies` | pinned (same as `dependencies`)                 | not pinned                                           |
| `peerDependencies`     | not pinned                                      | not pinned                                           |
| `devDependencies`      | not pinned                                      | not pinned                                           |

All four produce edges (build set); only pinning differs.

**A.7.8 Fixed groups (v0.2).** `groups` maps a name (unit id characters; group names and unit ids are separate namespaces) to `units` (ids) and/or `tags` (released units with any of the tags). `loadWorkspace` resolves members: unknown id `E_GROUP_UNKNOWN_UNIT`, a unit in two groups `E_GROUP_OVERLAP`, a group selecting nothing `W_GROUP_EMPTY`. `validateRelease` rejects an unreleased member named in `units` (`E_GROUP_NOT_RELEASED`) and members with different schemes (`E_GROUP_SCHEME`).

When any member is pending, all members release with one shared version; members without changes get `changes: []` and the group version. The group base tag is the highest stable member tag merged into HEAD, and the group line base the highest such tag on HEAD's first-parent chain; for equal versions the tag whose commit descends from the other's wins. `groupFrom` is the group base version. A member's commit range (A.7.6 step 3) starts at its own base tag when that tag's commit descends from the group base tag's, else at the group base tag, so changes a member already released alone are not counted again. `next = max(bump(groupFrom, L), max_i releaseAs_i)` with `L` the max member level after propagation; on a first release (no group base tag) the bump is replaced by the max of the members' initial versions. A member's Release-As at or below `groupFrom` is ignored with `W_RELEASE_AS_INVALID` (the message names the group); values of several members combine by max, without a conflict. One group `PreCtx`: `unit` = first member by id, `baseTag` = group base tag, `tags` = union of member tags (scheme-sorted), `sinceLineBase` = first-parent commits since the group line base, without one the max over the members' counters (the oldest introduction wins), `total` = max over members; `scheme.release`/`scheme.prerelease` run once and the result is assigned to every member. An absorbed bump is a pending bump: a member released only through absorption behaves like one with a direct change. Tags and changelogs stay per unit; a member's `from` and `baseTag` in the plan are its own, the group's are in `groups[]`.

**A.7.9 Branch rules and maintenance limits (v0.2).** First rule matching `--branch` or the current branch wins. Patterns are anchored and support `*` (any characters, including `/`) and `{major}`/`{minor}` captures (`0|[1-9][0-9]*`); each token at most once, `{minor}` only with `{major}`, anything else in braces is `E_BRANCH_RULE`. A maintenance rule caps bumps at `minor` with `{major}` and at `patch` with `{minor}` (`line.maxBump`).

| Rule shape                  | Default (relative) check per releasing release item       | Absolute check                                                                                                                 |
| :-------------------------- | :-------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------- |
| `release/{major}.x`         | max bump `minor` (`core(next).major == core(from).major`) | only if the rule sets `unit: <id>` or `group: <name>`, or the repo has exactly one release item: `core(from).major == {major}` |
| `release/{major}.{minor}.x` | max bump `patch` (same major and minor as `from`)         | as above, also `core(from).minor == {minor}`                                                                                   |

A release item is an ungrouped released unit or a fixed group; a group is checked with `groupFrom` and the group `next`. The plan records the limit in `line.maxBump` and the absolute target in `line.absolute` (`unit` or `group`, also for a single release item). `unit` and `group` are mutually exclusive and only allowed on a maintenance rule with `{major}`; a `unit` that is not an ungrouped released unit or an unknown `group` is `E_BRANCH_RULE` (`validateRelease`). First releases (no `from`) are not checked.

Violation: `E_CAP` naming the unit or group, the limit, `from`, `next` and the commit(s) that produced the offending bump (sha, subject, level and `via` for absorbed changes): changes whose level exceeds the limit and Release-As values off the line. For a group, a commit seen by several members is listed once with its highest level. A Release-As above the limit is `E_CAP` like a bump. Absolute mismatch: `E_CAP_BASE` naming the branch, the unit or group (marked as the only release item when the rule names none) and its `from`, checked whether or not the item releases. Typical causes: the branch was cut from or merged with a commit carrying a newer tag, or it is a next-major branch, which maintenance rules do not support (use a default-line rule with a channel). The implicit check stops once a second release item appears; add `unit:` or `group:` to the rule to keep it. Relative limits keep monorepos correct: `release/1.x` named after `web` does not block `api` at `5.3.0` from releasing `5.3.1`. No matching rule: build set computed, `line: null`, versions `null`, `W_NO_BRANCH_RULE`; `from`, `bump` and `next` are still computed with default-line rules.

Channels: literal `[0-9A-Za-z-]+` with at least one letter or dash outside tokens, optionally containing `{major}`/`{minor}` tokens captured by the same rule (e.g. `rc-{major}` renders `rc-1` on `release/1.x`). Errors raised by `validateRelease` (`check` and `computePlan`): same channel template on two rules (`E_CHANNEL_DUPLICATE`), a channel on a rule whose pattern contains `*` (`E_CHANNEL_WILDCARD`), any other token or character (`E_CHANNEL_INVALID`).

**A.7.10 Version and kind (v0.2).**

| In build set | Pending bump | Channel | Kind                              | Version                                                                             |
| :----------- | :----------- | :------ | :-------------------------------- | :---------------------------------------------------------------------------------- |
| yes          | yes          | set     | `prerelease`                      | `scheme.prerelease(next, ctx)`; semver: `{next}-{channel}.{N}`, `N = sinceLineBase` |
| yes          | yes          | none    | `rebuild`                         | `null`                                                                              |
| yes          | no           | any     | `rebuild`                         | `null`                                                                              |
| no           | yes          | any     | `none` (listed only with `--all`) | `null`                                                                              |

Group members share `next`, `version` and `N` (A.7.8). Unreleased units never have a pending bump: they are kind `rebuild` when affected and never listed as kind `none` under `--all`. Units outside the build set without a pending release are not listed. `next` is set for every pending unit, whatever its kind.

Stable releases are not units of the HEAD computation. `plan.released` is derived from durable facts only: every stable unit tag whose commit lies on HEAD's first-parent chain in `(build.base, HEAD]`; a maintenance tag reached only through a merge-back is not listed. When `base` is `null` only tags at HEAD are listed, with `W_RELEASED_NO_BASE` when earlier releases on the chain are left out, so a run without a base never re-emits history. Core fills it with `withReleased(workspace, plan, { git })`; `computePlan` leaves `released` empty, so `pr`, `version`, `shadow` and `explain` neither read the extra tags nor warn; `plan` and `run` fill it. `run` fails with `E_BASE_REQUIRED` before any effect when the base is `null` because the forge failed (`W_FORGE_ERROR`) instead of emitting less (`run` needs a token, so `W_NO_FORGE` cannot cause it). `releasedFromTags(workspace, plan, { git, tags })` builds entries for named tags; the caller passes the union by tag of the `plan.released` tags and the tags a reconcile created in the same run (same-sha no-op tags included). Group members are listed per unit. Order: oldest release commit on the first-parent chain first, then plan unit order (topological), then tag name; `line` is the matched rule's kind. `catchUp` is `releaseSha != head` or the unit is not in the build set (`affected` null); a release at HEAD of a unit outside the build set warns `W_RELEASE_NOT_BUILT` (with `unit`) and is listed as a catch-up. `latest` is true for the unit's highest stable tag among all its matched tags, never on a maintenance line; reconcile uses it for `make_latest`. Core sets `forge: null`. The cli (`releasedForge`) fills it from the reconcile of the same run (PR number and URL, release URL from creating or finding the release, `null` for a release a dry run would create), else looks up `prForCommit(releaseSha)` and `releaseByTag(tag)`; without a forge, or on a forge error in `plan` (`W_FORGE_ERROR`), `forge` stays null. Because the build base falls back to `lastSuccess` after a failed run (A.7.5), releases whose publish failed are emitted again by the next run; publishers treat "already published" as success.

`N` monotonicity: along a line's first-parent chain, `sinceLineBase` grows by at least 1 per commit, and the line base only moves when a stable tag of the unit lands on that chain, which also raises `next`, including a tag created from the line itself (that release becomes the new `from`). Merging a maintenance branch back moves the base tag (e.g. 1.4.2 to 1.4.3) but not the line base, so `N` never drops while `next` stays 2.0.0. Without a line base `N` counts from the unit's introduction, which is fixed history; the first stable tag on the chain moves the origin to that line base and raises `next`. The sha (`plan.head`) is the deployable identity of `rebuild` units and is never part of the version string.

### A.8 Plan and affected schema (v1)

```ts
interface AffectedDoc {
  // tallyrelease affected --json (v0.1)
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
    reason: "direct" | "dependent" | "global" | "all" | "group"; // group: v0.2
    via: string[];
    released: boolean; // Unit.version != "none"
    tags: string[]; // Unit.tags
  }[];
  unattributed: string[];
  warnings: { code: string; message: string; plugin?: string; unit?: string }[]; // unit: the unit a warning concerns
}

interface Plan extends Omit<AffectedDoc, "units"> {
  // tallyrelease plan --json (v0.2)
  line: {
    rule: string; // the matching branch rule's name
    kind: "default" | "maintenance";
    channel: string | null; // rendered with the rule's captures
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
  sha: string; // plan head
  changes: {
    // core commit order (A.5)
    sha?: string; // absent for file-based changes
    type: string;
    breaking: boolean;
    scope?: string;
    subject: string;
    notes?: string; // BREAKING CHANGE footer text (v0.3)
    pr?: number;
    via?: string; // absorbed unit
    releaseAs?: string; // this commit's Release-As value for the unit, normalized; only values that parse
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
}
interface ReleasedUnit {
  // v0.3
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
}
```

A group member's `bump`, `next` and `version` are the group's and its changes are read from the group range (A.7.8), while its `from` and `baseTag` are its own; `groups[]` carries the group's base tag and `from`. `explain` prints the source of a member's `next` when it is not the group bump (for example `group sdk, release-as`).

`explain` and the changelog list absorbed Changes under the released unit with `via <unit>`. Build selection in `AffectedDoc` depends on release status only through changelog ownership (A.7.4); `released` otherwise only reports it.

The cli publishes `plan.schema.json` and `affected.schema.json` (generated from zod) in the npm package (exports `@tallyrelease/cli/plan.schema.json` and `@tallyrelease/cli/affected.schema.json`). The schemas are strict (`additionalProperties: false`). Within schema 1, new optional fields and new enum values are allowed; consumers validate with the schema of the tool release they run. Removing or renaming fields bumps `schema`. Fields filled by later milestones are emitted with their empty values (`group: null`, `groups: []`, `released: []`).

### A.9 CLI surface

| Command                                                                                                                                       | Milestone | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| :-------------------------------------------------------------------------------------------------------------------------------------------- | :-------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tallyrelease check`                                                                                                                          | v0.1      | Validate config, plugins, units, graph and, from v0.2, release config (`validateRelease`: schemes, tag formats, initial versions, branch rules and channels). With at least one released unit it also reads the repository's tags (so it needs a git repository): tags parsing for two released units are `E_TAG_FORMAT_OVERLAP`, and a released unit without a matching tag while a tag contains its id warns `W_NO_MATCHING_TAG`. Non-zero on `E_*`. Prints `ok: N units (K released: a, b), M edges`, or `(0 released)`, with singular `1 unit` and `1 edge`.                                                                                                                                                                                                                                                                                                                |
| `tallyrelease graph [--format <format>] [--json]`                                                                                             | v0.1      | Units and edges. `--format` is `text` (default), `json` or `mermaid`; `--json` is shorthand for `--format json`, and combining them exits 2. Mermaid is a raw `flowchart LR` (solid pinned, dashed unpinned edges, released units marked). Text is a table (`UNIT`, `PATH`, `PLUGIN`, `RELEASE` with the effective version or `-`, and `TAGS` when any unit has tags), a `dependents` tree from units without dependencies (skipped without edges; `(*)` marks a unit expanded above, `(cycle)` an edge back into the current path) and a summary line; `no units` when empty. Pinned status is only in json and mermaid.                                                                                                                                                                                                                                                       |
| `tallyrelease affected [--base] [--format <format>] [--json] [--out <file>] [--github-output] [--tag <tag>]`                                  | v0.1      | Build set. `--format` is `text` (default), `json` or `tsv`; `--json` is shorthand for `--format json`, and combining them exits 2. Text shows the base (short sha and its source), units grouped by reason (`all`, `global` with the changed global inputs, `direct`, `dependent`, `group`) with `via` and a `released` marker, and a summary. TSV is a header `id\tpath\treason\tvia\treleased\ttags` and one row per unit (`via` and `tags` comma-joined, `released` is `true` or `false`). `--tag` (repeatable) keeps units with at least one of the given tags in `units` of every format and output (`via` may name dropped units); `build` is unchanged and the text summary counts only tagged units. A tag no unit has warns `W_TAG_UNKNOWN`. Text layout may change between versions; `json`, `tsv` and `mermaid` are the stable formats.                              |
| `tallyrelease plan [--branch] [--base] [--head <ref>] [--all] [--format <format>] [--json] [--out <file>] [--github-output] [--summary]`      | v0.2      | Full plan, read-only. `--branch` defaults to the `affected` branch (PR head, else `GITHUB_REF_NAME`, else the checked-out branch, else `HEAD`); `--head <ref>` plans that commit's files with the current config (A.4), even when it equals HEAD; then only `--base` and the local merge base apply (A.7.5 rows 1, 5, 6), and without `--branch` it warns `W_HEAD_BRANCH` because the branch rule still comes from the current branch. `--all` adds released units outside the build set with a pending release (kind `none`). `--format` is `text` (default) or `json`; `--json` is shorthand, and combining them exits 2. Text is a table (`UNIT`, `GROUP` when any unit has a group, `KIND`, `FROM`, `BUMP`, `NEXT`, `VERSION`) and a summary. `--out` writes the JSON plan; `--github-output` writes `plan` (A.11). `--summary` writes markdown (branch line, base, a `Unit | Group | Kind | From | Bump | Next | Version`table with`Group`only when any unit has a group, warnings as a list) to`$GITHUB_STEP_SUMMARY`, or prints it instead of the text table when unset; with `--json`and no`$GITHUB_STEP_SUMMARY` it exits 2 because both use stdout. |
| `tallyrelease explain <unit> [--branch] [--base]`                                                                                             | v0.2      | Text only. Base line as in `plan`, affected reason with the attributed files and `via`, `from -> next` with bump and version, base tag, changes (sha, type, subject, files, `via <unit>` for absorbed changes), propagation sources with edge pinning, and Release-As footers (the applied one as recorded by the planner, the others ignored). Prints the plan warnings of the unit (`Warning.unit`) and those of no unit. `--branch` and `--base` as for `plan`. Unknown id: `E_UNIT_UNKNOWN`.                                                                                                                                                                                                                                                                                                                                                                                |
| `tallyrelease shadow [--manifest <path>] [--rp-config <path>] [--head <ref>] [--branch] [--pin <spec>] [--out <file>] [--summary] [--strict]` | v0.2      | Shadow comparison (A.13). `--head` replays an earlier release-please merge; `--branch` defaults as for `plan`; `--pin` is recorded as `pin` and `GITHUB_SHA` as `sha` in the report; `--out` writes the report JSON; `--summary` appends markdown to `$GITHUB_STEP_SUMMARY` (printed instead of the text table when unset); `--strict` exits 1 on an unlabelled row. Skips (`W_SHADOW_SKIPPED`, exit 0) when the manifest did not change or the plan fails with `E_CAP`/`E_CAP_BASE` (reason `cap`). A manifest or release-please config that is not a JSON object (the manifest with string values) is `E_SHADOW_INPUT`; an explicitly passed `--manifest` or `--rp-config` missing at `HEAD` warns `W_SHADOW_INPUT_MISSING`.                                                                                                                                                  |
| `tallyrelease version [--branch] [--dry-run]`                                                                                                 | v0.3      | Writes `releaseFiles` (plugin version files, templates, `<root>/CHANGELOG.md`) of all pending release items of `plan --all` to the working tree and prints `updated <path>` per changed file (`would update` with `--dry-run`, which writes nothing), else `no version files to update`. Changelog date: the UTC date of `clock`; links from `GITHUB_SERVER_URL`/`GITHUB_REPOSITORY`, else the `origin` URL as https, else none. A second run is a no-op.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `tallyrelease pr [--branch] [--dry-run]`                                                                                                      | v0.3      | Release PRs (A.12 step 3) for all pending release items of `plan --all`: one shared PR on `tallyrelease/release/<branch>/shared`, one PR per `separate` item on `tallyrelease/release/<branch>/<item>`, title and commit `chore(release): <branch>` for the shared PR and `chore(release): <item>@<version>` for a separate one. Prints `created PR #n <branch>: <title>`, `updated PR #n ...`, `PR #n <branch> is up to date` or `closed PR #n <branch>` (`would push <branch>`, `would create`, `would update`, `would close` with `--dry-run`, which pushes nothing and edits no PR), else `no release PRs`. Needs a forge (`E_NO_FORGE` without a token); the repository is `GITHUB_REPOSITORY`, else taken from the `origin` URL. A second run with the same HEAD on the same day is a no-op.                                                                              |
| `tallyrelease release [--branch] [--dry-run]`                                                                                                 | v0.3      | Reconcile (A.12 step 1): merged release PRs labelled `tallyrelease: pending` on the branch, oldest merge first. Prints per PR `PR #n: tagged <tags> at <sha>`, `moved <floating tags>`, `created releases <tags>`, `labelled released`, `labelled stale: <reason>` or `merge <sha> is not in HEAD; left pending` (`would tag`, `would move`, `would create`, `would label` with `--dry-run`, which keeps its tags in memory so later PRs and `E_TAG_EXISTS` are evaluated, and writes no ref, pushes nothing and edits no PR), else `no merged release PRs`. Needs a forge (`E_NO_FORGE`); a forge error while listing release PRs fails the command. A second run is a no-op.                                                                                                                                                                                                  |
| `tallyrelease run [--branch] [--base] [--dry-run] [--out <file>] [--github-output] [--summary]`                                               | v0.3      | CI entry point: `release` (A.12 step 1), then the plan at HEAD with the A.7.5 build base (`--base` overrides it for manual recovery) and `released` (A.7.10) united by tag with the tags of every PR reconciled in this run, then `pr` with those PRs exempt from `E_PENDING_RECONCILE`, then the outputs of `plan` (`--out`, `--github-output` writes `plan`, `--summary`). Prints the `release` lines, the `pr` lines, then the plan table. The build base is resolved after the skip checks and before any effect: when it is null because the forge failed (`W_FORGE_ERROR`), `run` fails with `E_BASE_REQUIRED` and changes nothing. `--dry-run` runs `release` and `pr` as dry runs and plans with the tags `release` would create. A warning repeated by a later step prints once. A second run changes nothing.                                                         |

`version`, `pr`, `release` and `run` do nothing and warn `W_EFFECT_SKIPPED` on `pull_request`, `pull_request_target` and `merge_group` events and on a branch without a line rule.

Global flags: `--cwd`, `--config`, `--token` (else `GITHUB_TOKEN`), `--verbose`. Exit codes: `0` ok, `1` error (printed as `error[E_*]: message`), `2` usage. Warnings print as `warning[W_*]: <plugin: >message`. On a terminal, output is colored via `node:util` `styleText` (`NO_COLOR` and `FORCE_COLOR` apply). Commands run at the repository root and fail with `E_NOT_REPO_ROOT` in a subdirectory unless `--cwd` points at the root, with `E_NOT_A_REPO` outside a git repository and with `E_CWD_MISSING` when the directory does not exist. The cli entry is `main(argv, deps)` with `deps = { env, cwd, stdout, stderr, git?, fs?, fsAt?, forge?, gitWriter?, writeFile?, clock? }` (`fsAt(ref)` supplies the files of a commit for `--head`; `writeFile` writes relative to the repo root and fails with `E_PATH_OUTSIDE_ROOT` outside it; `clock` dates changelogs); `bin.ts` wires real deps; tests inject `memoryGit`, `memoryFs`, `fakeForge` and the fake writer in-process.

### A.10 Configuration (`tallyrelease.yaml`)

Defaults: units are not released (`release: false`, `version: none`); `tagFormat` = `{id}-v{version}`; a unit at root `.` defaults to `v{version}` (release-please parity for single repos); `propagate: auto`; `initialVersion` = the scheme's initial version (semver `1.0.0`).

The config schema is published as `dist/tallyrelease.schema.json` (export `@tallyrelease/cli/tallyrelease.schema.json`, also on jsDelivr), generated from the zod `configSchema`; an optional top-level `$schema` key is accepted and ignored.

Releasing is an explicit repo decision. `release: true` (per unit) or `defaults.release: true` (all units, with `release: false` opt-outs) opts units in; the plugin's version source applies unless an overlay sets `version: file | tag`. `version: none` is rejected with `E_CONFIG` (hint: `use release: false`).

Unit overlays accept `tags` (labels such as `docker` or `npm`, same characters as ids) to split the build set by kind with `affected --tag`. There are no default or plugin-provided tags.

A `units` key with `*` is a glob over unit roots (A.7.1): `*` is one path segment and skips dot directories. Globs apply in declaration order, exact keys win field by field, and `id`, `include`, `exclude` and `versionFiles` are not allowed on a glob key.

```yaml
units:
  "apps/*": { release: true, tags: [docker] } # * is one segment, skips dot dirs
  "packages/*": { release: true, tags: [npm] }
  packages/tsconfig: { release: false } # exact key wins field by field
```

`initialVersion` (in `defaults` or a unit overlay, parsed by the unit's scheme, else `E_INITIAL_VERSION`) is the version of a unit's first release (A.7.6). To adopt tallyrelease in a repo whose history predates its tags, push a baseline tag for each released unit instead. `branches` are matched in order (A.7.9); `line` is required, `channel` optional; a maintenance rule may name `unit` or `group` for the absolute check. `bumps.types` is merged over the defaults; `bumps.absorbed` (`patch` default, or `minor`) sets the level of changes absorbed from unreleased dependencies (A.7.6); `bumps.preMajor` applies while the major version is 0: `breaking` to breaking changes, `feat` to changes whose type level is `minor`. Its default `breaking: minor` differs from release-please's default (`bump-minor-pre-major: false`); set `preMajor.breaking: major` for parity, otherwise shadow labels the difference `release-config`.

`groups` (A.7.8) are fixed only: a map from a group name to `units` and/or `tags`. Moving a unit into a group switches its Release-As from override to max: an ungrouped unit's value sets `next`, a member's value only raises the group version.

`releasePr` (v0.3, `shared` or `separate`, in `defaults`, ungrouped unit overlays and `groups.<name>`, default `shared`) picks the release PR of a release item (A.12). On a grouped unit it is `E_CONFIG` (set it on the group). An ungrouped released unit whose id is a group name, an item named `shared`, or an item name that is not a valid branch name component (leading or trailing `.`, `..`, trailing `.lock`) is `E_RELEASE_ITEM_NAME`. An edge whose effective policy propagates a patch (`auto` with a pinned edge, or `patch`) between released units of items in different release PRs is `E_RELEASE_PR_SPLIT_EDGE`, since one PR could ship a pin or a dependency release for a version the other PR has not released. `validateRelease` runs these checks, so `check` reports them. `tags.floating` formats accept only `{id}`, `{major}` and `{minor}` (else `E_CONFIG`).

`versionFiles` (v0.3, unit overlays) lists templated text replacements `{ file, pattern }`, `file` relative to the repository root, tokens `{id}`, `{version}`, `{major}`, `{minor}`, `{patch}`. `file` is normalised (`./README.md` is `README.md`); `.`, absolute paths and `..` segments are `E_CONFIG`. A pattern needs a version token and literal text, may not mix `{version}` with `{major}`, `{minor}` or `{patch}` (their values could disagree), and other tokens are `E_CONFIG`; a template on a plugin version file is `E_VERSION_FILE_CLAIM` (checked by `check` and when release files are built, since plugin `versionFiles` hooks run only then). A match (an edge that is a token or a letter or digit must not touch another letter or digit, so `@v{major}` matches in `org/repo@v1`; never followed by `.<digit>`) is replaced with the rendering of `next` when its values render a version `v` with `from <= v < next`, compared over the tokens present, so `run-v2` left by a stale merge still moves. A first release leaves templates alone; a missing file is `E_VERSION_FILE_MISSING`; a pattern with no match at all warns `W_VERSION_FILE_NO_MATCH` (a match already at `next` is silent). The node plugin writes `package.json`: `version`, and in `dependencies` and `optionalDependencies` the exact ranges (`1.2.3`, `=1.2.3`, `workspace:1.2.3`, prefix kept) of packages released together; `workspace:*`, `workspace:^`, `workspace:~` and ranges stay, as do exact pins in `devDependencies` and `peerDependencies` (not part of the published install, and the node edges treat them as unpinned, so they cause no release); indentation, CRLF line endings and the trailing newline are kept.

```yaml
units:
  actions/run-tallyrelease:
    release: true
    versionFiles:
      - { file: README.md, pattern: "abinnovision/actions@{id}-v{major}" }
```

While release-please owns versions, do not use qualified `Release-As: <unit>@<version>` footers: release-please reads `core@1.0.0` as a version. Plain `Release-As: <version>` footers work in both.

```yaml
# Yarn monorepo (app-stack consumer)
plugins:
  node: {} # map: only listed plugins run, in this order
defaults:
  tagFormat: "{id}-source-v{version}" # set to the repo's existing tags for shadow parity
  initialVersion: 0.1.0 # first release without a tag; default: the scheme's initial version
units: # overlays keyed by root path; undiscovered root => config-only unit
  ".": {} # id defaults to the repo name; build-only
  "apps/web": { id: web, release: true, tags: [docker] } # tags: labels for affected --tag
  "packages/api-client": { release: true }
  "packages/api-types": { release: true }
  "infra/tf": { id: tf, release: true } # config-only unit, version source tag
deps:
  - { from: api-types, to: tf, pinned: false }
ignore: ["**/*.md", ".github/**"]
globalInputs: [".tool-versions"] # unioned with node defaults and tallyrelease.yaml
# v0.2
groups: # fixed: members release together with one version
  sdk: { units: [api-client, api-types] } # or { tags: [docker] }: released units with the tag
  # v0.3: sdk: { units: [api-client, api-types], releasePr: separate }
branches:
  - { name: main, line: default, channel: beta }
  - { name: "release/{major}.x", line: maintenance, group: sdk } # or unit: <id>; absolute check (A.7.9)
  - { name: "release/{major}.{minor}.x", line: maintenance }
bumps:
  types: { feat: minor, fix: patch, perf: patch, revert: patch }
  preMajor: { breaking: minor, feat: minor }
# v0.3
tags:
  floating: ["{id}-v{major}", "{id}-v{major}.{minor}"]
```

```yaml
# PHP single repo
plugins:
  php: {}
units:
  ".": { release: true }
branches:
  - { name: main, line: default }
  - { name: "{major}.x", line: maintenance } # single released unit: absolute check applies
# v0.3
tags:
  floating: ["v{major}"]
```

```yaml
# App monorepo (groundwork): internal packages are absorbed into the apps
plugins:
  node: {}
defaults:
  tagFormat: "app-{id}-v{version}"
units:
  "apps/api-server": { release: true }
  "apps/groundwork": { release: true }
groups:
  groundwork: { units: [api-server, groundwork] } # like release-please linked-versions
```

```yaml
# Library monorepo (this repo)
plugins:
  node: {}
units:
  packages/core: { id: core, release: true }
  packages/cli: { id: cli, release: true }
```

```yaml
# Many published packages
plugins:
  node: {}
defaults:
  release: true
units:
  packages/tsconfig: { release: false }
```

Node defaults: discovery from `workspaces` (yarn/npm) or `pnpm-workspace.yaml`; a single-package repo is unit `.`; a workspace root `package.json` is not a unit unless overlaid. Global inputs: `yarn.lock`, `package-lock.json`, `pnpm-lock.yaml`, `.yarnrc.yml`, `.yarn/patches/**`, root `package.json` (workspace repos), root `tsconfig*.json`, `turbo.json`. Ids via `defaultUnitId`; `meta.node.packageName`; version source `file`. PHP: unit from root `composer.json` plus `composer.json` under `repositories[type=path].url` globs; edges from `require`/`require-dev` naming a local package (pinned only for exact constraints in `require`); version source `tag`, no version files; global input `composer.lock`.

Kustomize (build-only): every directory with a `kustomization.yaml`, `kustomization.yml` or `Kustomization` is a unit, bases included. Ids are the path with `/` replaced by `-` (`k8s/applications/staging` is `k8s-applications-staging`; `.` uses the repo name), so a collision is fixed with a `units.<root>.id` overlay. Local `resources`, `bases`, `components` and other path fields (patches, generator files, Helm values) are read from the kustomization. A reference to another kustomization directory becomes an edge from the referenced unit to the referencing one (reason `resources: ../../base/backend`). A reference to a file or directory outside the unit root that is not a unit is added to the unit's `include`, so changes there affect every referencing unit. Remote, absolute and repo-escaping references are skipped; missing targets warn. Option `paths` (default `["**"]`) limits discovery to directory globs, which keeps the plugin away from directories owned by other plugins. There are no global inputs and no version files.

```yaml
# GitOps repo: which applications changed?
plugins:
  kustomize: { paths: ["k8s/**"] }
```

With `k8s/base/backend` and `k8s/applications/{staging,production}` referencing it, a change under the base marks the base as `direct` and both applications as `dependent`; a change in one application affects only that application.

### A.11 CI integration (`abinnovision/actions`)

A JS action (`run-tallyrelease`, `node24` runtime) in `abinnovision/actions` runs the published cli.

| `$GITHUB_OUTPUT` key  | Milestone | Value                                                                          |
| :-------------------- | :-------- | :----------------------------------------------------------------------------- |
| `affected`            | v0.1      | Compact JSON array `[{id,path,plugin,reason,released,tags}]`                   |
| `affected-paths`      | v0.1      | Newline list of paths (multiline delimiter syntax)                             |
| `all`                 | v0.1      | `true` when base is `null` or a global input hit                               |
| `base`, `base-source` | v0.1      | Resolved base sha (empty if none) and its source                               |
| `plan`                | v0.2      | Path of the written plan (`--out`, else `$RUNNER_TEMP/tallyrelease-plan.json`) |
| `releases`            | v0.3      | Generic release list (`run`), compact JSON, order below                        |

Requirements (README): checkout with `fetch-depth: 0` (or `filter: blob:none`); `actions: read` for base lookup; one run per branch via `concurrency` without `cancel-in-progress` on pushes (queued runs may still be replaced, which A.7.5 row 2 and A.12 reconciliation tolerate); tags pushed with `GITHUB_TOKEN` do not trigger workflows, so publishing runs in the same workflow from `releases`; entries with `catchUp: true` must be built from `releaseSha`, not HEAD, and outside the `affected-paths` filter, since a caught-up unit may not be in HEAD's build set (actions-repo task); the default token is the plain `GITHUB_TOKEN`, and PRs it creates do not trigger workflows, so users who need required checks on release PRs pass another token with `--token`.

`abinnovision/actions` itself publishes actions as orphan commits with built `dist`. tallyrelease only owns its reachable `{id}-source-v{version}` tags there (`tags.floating` unset); the existing actions-repo step keeps creating orphan commits, version tags and floating tags from `plan.released`. Tier 2 local plugins are therefore not a prerequisite for M4a.

Rollout: M2a app-stack input `build-selection: affected|all` (default `all`) filters prune, pack and image matrices by `affected-paths`.

Shadow (v0.2) is not part of the action: each repo runs a standalone push-only workflow (concurrency group per commit sha, so a release merge is never cancelled by later pushes; `contents: read`, `issues: write`; checkout with `fetch-depth: 0` and `persist-credentials: false`) with `shadow --out shadow-report.json --summary` as a `continue-on-error` step, so neither mismatches nor errors fail the run before `--strict`. It uploads the report as an artifact and comments the summary on its tracking issue (`vars.SHADOW_ISSUE`) unless the report is skipped. This repo builds the cli from source; consumers run `npx @tallyrelease/cli@<exact version> shadow --pin <exact version>`. Since app-stack 1.3.0 shadow and plan run inside app-stack (see below); the standalone job remains in this repo only (A.13).

**Release list** (v0.3). `releases` is the generic list `run --github-output` writes (within a major, entries only gain fields): `[{ id, path, kind: "release" | "prerelease", version, channel, tag, releaseSha, catchUp, forge, latest, changes, tags, group }]`. `channel` is null for releases. `changes` has the shape of the plan's `units[].changes`: the unit's own changes, then those of the units in its `propagatedFrom`, transitively (depth first, in `propagatedFrom` order), each copied change keeping its `via` or else getting the id of the unit it was copied from; a sha is listed once, changes without a sha always, group members are not pulled in. For a release the units come from the plan at the first parent of `releaseSha` (reused from the reconcile of the same run), `[]` without a parent or unit; for a prerelease from the HEAD plan. `releaseSha` is always the full sha. Releases come first (`plan.released` order: oldest release commit first, then plan unit order), then prereleases in plan unit order, none for a unit released at HEAD; a prerelease has `tag: null`, `releaseSha = plan.head`, `catchUp: false`, `forge: null`, `latest: false`. `tags` is the unit's sorted tags, `group` its fixed group name or null. `forge` and `latest` are those of `plan.released` (A.7.10). Every stable tag in range is emitted, also several of one unit, so no tagged version stays unpublished; `latest` marks the highest.

Every `catchUp: false` entry belongs to a unit in the build set of the same run, so `release-build` only needs `catchUp: true` entries, which may be at HEAD when the unit was outside the build set. `latest` is computed at run time from the local tags: "re-run failed jobs" reuses the `release` job outputs, so re-running an old failed publish after a newer release of the unit would publish with `latest: true`. Prefer letting the next run re-emit the release (A.12 step 2).

**app-stack** (`tallyrelease: off | shadow | release`, default `off`; `off` and `shadow` output stays byte-identical):

| Mode      | Behaviour                                                                                                                                                                                                                             |
| :-------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `off`     | `run-release-please` as before.                                                                                                                                                                                                       |
| `shadow`  | `run-release-please` as before; the `Release plan` job runs `plan --summary` and `shadow` (A.13).                                                                                                                                     |
| `release` | The `release` job replaces `run-release-please`: full-history checkout with `persist-credentials: false`, broker token as `token`, `run --github-output` after `check` and `test`; the `Release plan` job runs `plan --summary` only. |

- Mapping to release list schema 1: `name` (last path segment, not the id), `path`, `version`, `channel` (`""` for releases), `sha` (7 characters of `releaseSha`, so OCI `sha-<sha>` names the built commit), `url` (`<server>/<repo>/releases/tag/<tag>` for releases, or `forge.release.url`) and optional `catchUp`, `releaseSha`, `tag`; `payloads` point at `payload-source`/`payload-dist` when the entry is built at HEAD, else at `payload-source-<sha7>`/`payload-dist-<sha7>`.
- `release-build` job (`needs: release`, skipped when nothing needs it, permissions as `check`): builds entries not built at HEAD (catch-ups) at their `releaseSha`, grouped by sha through a matrix over the `release-builds` output of the `release` job. It has its own checkout at `matrix.sha` and shares the prune, install, build and pack steps with `check` through YAML anchors. Catch-up payloads are built without re-running tests. `CI / Status` needs it.
- `latest` and GitOps dispatch come from the list: a release entry takes `latest` (OCI and npm; a non-highest npm publish gets the dist-tag `backport`) and dispatches when `latest` is true. A prerelease dispatches on `run_attempt == 1` or when `releaseSha` equals the tip of the calling run's branch. A re-run of an old run therefore never rolls back, and a re-run after a failed dispatch dispatches.
- Releases only on the default branch; maintenance lines (`makeLatest: false`) are a cli capability for repos that call `run` themselves. The caller workflow needs workflow-level `concurrency` per branch without `cancel-in-progress` on pushes; `release` has no job-level concurrency, since that cancels pending jobs and marks `CI / Status` cancelled.
- Permissions per command (token via `--token` or `GITHUB_TOKEN`; the cli does not know the broker): `affected` and `plan` `contents: read` and `actions: read` (base lookup); `pr` `contents: write`, `pull-requests: write`, `issues: read` (label listing); `release` the same plus `actions: read`; `run` the union. Tags and PRs created with `GITHUB_TOKEN` trigger no workflows.
- Publisher idempotence: "already published" is success. `publish-npm` skips existing versions and publishes oldest first with a `version_map` per artifact; `publish-oci` probes `<image>:<version>` on every configured registry and skips build and push when all have it, with `flavor: latest=false`; `publish-linear` keeps the highest version per access key and treats only the duplicate-version error as success. GitHub releases are fetched by tag first and created only when missing.
- Stuck-run recovery: `E_BASE_REQUIRED` (forge failed while resolving the base): re-run when the forge is healthy and check `actions: read`; never bypass, since an empty base would advance `lastSuccess` past unpublished releases. `E_PENDING_RECONCILE`: run `release` (or `run`) first. `E_TAG_EXISTS`: a version tag points at another commit; inspect both, delete the wrong tag or relabel the PR `tallyrelease: stale`, then re-run. `E_PUSH_LEASE`: another writer moved the release branch; re-run. Never remove `tallyrelease: pending` from a merged PR; if it happened, re-add it and re-run.
- Limits: "re-run failed jobs" reuses the `release` job outputs and artifacts, so only publishers re-run. A prerelease is redeployed on re-run only while it is still the line tip. GitOps dispatch is all-or-nothing on build success, so a failed catch-up build also blocks the HEAD deploy. Publishing in a separate workflow is not retried by the release run. Prerelease numbers (`N`, first-parent commits since the line base or, without one, since the unit's introduction) differ from release-please's changelog-worthy count but are never lower for the same `next`: without a line base, release-please counts unit commits since the introduction, which on squash histories are a subset of the counted first-parent commits.

### A.12 Release flow (v0.3)

Every run on a line branch, after step 1 of A.4 (config, plugins, `loadWorkspace()`, build base):

1. **Reconcile (tagging).** List closed PRs with head `tallyrelease/release/<branch>/shared` or `tallyrelease/release/<branch>/<item>`, base `<branch>`, `merged_at` set and label `tallyrelease: pending`, oldest first. The label is only a work queue for tagging; publishing never depends on it. For each PR, parse the marker `<!-- tallyrelease-plan:v1 base64({ head, releaseCommit, releases: [{ id, version, tag }] }) -->` and require:
   - `pr.head.sha == releaseCommit` (body and branch belong together; a racing rewrite fails this),
   - `merge_commit_sha` is an ancestor of HEAD,
   - **plan equality** (`planEquals`): every marker release equals the `{ id, version, tag }` of that unit in `planAt(firstParent(merge_commit_sha))`, and every group the marker touches is complete. Pending items outside the marker are ignored, so merging one separate PR never makes the others stale. This accepts merge queues where main moved without changing the release, and rejects merges whose versions would now differ.

   A PR whose `merge_commit_sha` is not in HEAD (a re-run of an old run) is left `pending` for a later run and never labelled stale. The plan at the first parent is computed with the working-tree config, the files of that commit and every tag the run already created, so each PR is checked after the tags of the earlier ones exist locally. A direct-push `chore(release): ...` commit without a PR is never listed and so ignored.

   When every marker tag already points at `merge_commit_sha` (a run after a partial failure), plan equality is skipped, so a later config change cannot block the recovery, and nothing is pushed unless a floating tag moves. Valid: create tags locally at `merge_commit_sha` (existing tag on the same sha: no-op; different sha: `E_TAG_EXISTS`, the run fails before pushing that PR's tags; PRs earlier in the same run may already be tagged and pushed), take the floating tags from `releasedFromTags()` (`floatingTags` of each entry), then push version tags and floating tags (`+refs/tags/...`) in one atomic push per PR with the token. The reader has no tag cache, so later plans see the new tags. Create a forge release per unit when `releaseByTag` finds none (a 422 on create counts as existing): name as release-please (`<prefix>: v<version>` when the tag ends in `-v<version>`, so `cli-v0.2.0` is `cli: v0.2.0`, else the tag), body = the unit's top `CHANGELOG.md` section at the merge sha, `make_latest` from the entry's `latest` (the unit's highest stable tag, never on a maintenance line), so a late release creation never takes latest back. Relabel `tallyrelease: released`. Invalid (no or malformed marker, head is not `releaseCommit`, plan equality fails): relabel `tallyrelease: stale` with a comment giving the reason; no tags.

2. **Plan** at HEAD. Tags from step 1 are visible because they exist in the local repo and the reader caches no tags. `plan.released` comes from tags in `(build.base, HEAD]` (A.7.10), so a release whose publish failed is re-emitted until a run succeeds, united by tag with the tags of every PR step 1 reconciled (same-sha no-op tags included), so a release reconciled by a run whose base is already past its merge is still listed. A null base caused by a forge failure fails the run with `E_BASE_REQUIRED` before step 1; without a base otherwise (first adoption) only releases at HEAD and those of step 1 are listed.
3. **Release PR** (`tallyrelease pr`). Skipped with `W_PR_HEAD_BEHIND` when HEAD is not the remote tip of `<branch>` (`branchSha`), so a re-run of an old run changes no PR; then fails with `E_PENDING_RECONCILE` while a merged PR labelled `tallyrelease: pending` exists on `<branch>` that step 1 of the same run did not reconcile. Desired PRs: one shared PR for all `shared` items and one per `separate` item (see Release PRs below). Per desired PR: `releaseFiles` of its items at HEAD (changelog date = the UTC date of the cli clock), then `commitFiles(HEAD, files, title)` on a temporary index with the identity from `GIT_AUTHOR_*`/`GIT_COMMITTER_*` (default `tallyrelease <tallyrelease@users.noreply.github.com>`) and HEAD's committer date as both dates, so the same HEAD, files and day give the same sha (`releaseCommit`). The open PRs (pending label, heads in this repository) are read once and matched by head branch; the remote branch sha (`branchSha`, the refs API) decides: the push is skipped when it equals the computed sha, otherwise all changed branches go in one atomic push with `--force-with-lease=refs/heads/<pr branch>:<branchSha>`, empty when the branch does not exist. Then the PR is created and labelled `tallyrelease: pending` (a 422 because an unlabelled open PR exists for the branch updates that PR instead), or its title and body are updated when the rendered body (which includes the marker with `head` and `releaseCommit`) differs, and the pending label is set again. Open pending PRs on `<branch>` that are not desired (empty release set, an item switched mode), and older PRs sharing a head with a newer one, are closed with a comment; branches of undesired PRs under `tallyrelease/release/<branch>/` are deleted with a lease before the PRs are closed. Merged PRs are never touched by `pr`. The body is one `<details><summary><id>: <version></summary>` block per unit holding its changelog section, then the marker.
4. **Outputs.** The plan of step 2 goes to `--out`, `--github-output` (`plan`) and `--summary`. `tallyrelease run` performs steps 1 to 4 in this order; `release` and `pr` perform steps 1 and 3 alone.

**PR body size.** The marker carries only `{ head, releaseCommit, releases }`, never the full plan. The human changelog part is cut to whole unit sections with a note so the body stays under 60,000 characters (GitHub limit 65,536).

**Maintenance hint.** On the default line, when an item's `next` has a higher `core().major` than its `from`, the body adds a note under the item's sections (`maintenanceCut(workspace, plan, item)`): the first maintenance rule with `{major}` and no `*` that targets the item or nothing, rendered from `from`, and `git push origin <tag>:refs/heads/<branch>` with the item's base tag (the group base tag for a group). First releases, maintenance lines and repos without such a rule get no note. Notes count toward the body size; the marker always stays.

**Release PRs** (v0.3). Each pending release item (`releaseItems`: a group or an ungrouped released unit with a stable `next`) goes to the shared PR on `tallyrelease/release/<branch>/shared` (`releasePr: shared`) or to its own PR on `tallyrelease/release/<branch>/<item>` (`separate`). Every PR branch is a leaf under its line branch, so shared and separate PRs never conflict; a group is never split. The marker (`encodeMarker`, base64 of UTF-8 JSON through a pure helper) holds the releases of the PR's items only.

**Floating tags** (`tags.floating`, tokens `{id}`, `{major}`, `{minor}`): core renders `ReleasedUnit.floatingTags` (pure, over the unit's tag names) and keeps a name only if the released version is the highest stable version among all of the unit's tags that render to the same name. So `v1` moves to `1.4.3` on `release/1.x` while `v2` stays put, and a maintenance release never moves a newer line's tag.

**Changelog writer** (core, pure, not a plugin hook, release-please format in `changelog.ts`): `<root>/CHANGELOG.md` per unit, also per group member, for stable releases only. Heading `## [<version>](<repo>/compare/<baseTag>...<tag>) (<date>)`, or `## <version> (<date>)` without a base tag or repo URL. The date is the date the release PR is generated, passed in by the cli (core reads no clock), so a rebuild on a later day changes the section; reconcile and plan equality compare releases, never file content. Sections: `⚠ BREAKING CHANGES` (the `BREAKING CHANGE` footer text, else the subject), `Features`, `Bug Fixes`, `Performance Improvements`, `Reverts`, hidden types only when breaking or carrying Release-As, then `Dependencies` (`* The following workspace dependencies were updated` / `  * <field>` / `    * <name> bumped to <version>`, from edge reasons, only for dependencies released in the same release PR). Breaking notes follow release-please: the last `BREAKING CHANGE` footer, its first paragraph on one line, list or `####` lines kept indented below. Entries `* **<scope>:** <subject> ([#<pr>](<repo>/issues/<pr>)) ([<sha7>](<repo>/commit/<sha>))`, absorbed ones with ` (via <unit>)`, sorted like release-please (scope and linked subject concatenated, compared with `localeCompare`, over changes in core commit order); a group member with nothing listed gets `* **<id>:** Synchronize <group> versions`. Without a repo URL there are no links. The writer keeps the text before the first version heading (`##` or `###`, linked or plain), replaces every section whose version is greater than the base version (untagged leftovers; without a base version, sections not below the new one) with the new section on top, and creates `# Changelog` when the file is missing, so reruns and stale recoveries never duplicate sections. The release commit body has no line starting with a footer token, so squash merges add no footers.

**Stale recovery.** A stale merge (plan equality fails) leaves the release commit on main without tags. The next plan still uses the old base tag; the `chore(release)` commit causes no bump; version file writers set versions to the new `next` and the changelog writer replaces the untagged section. The next release PR therefore contains exactly one changelog section above the base tag and version files equal to the new plan.

Effects are idempotent and support `--dry-run`.

### A.13 Shadow mode (v0.2)

- **Trigger:** only pushes whose `git diff --name-only HEAD^1 HEAD` contains the release-please manifest (`--manifest`, default `.release-please-manifest.json`), i.e. a release-please release PR merge. Other pushes, and root commits, exit 0 with `W_SHADOW_SKIPPED` (reason `manifest`). `--head <ref>` replays an earlier merge.
- **Compute:** read the manifest at `HEAD^1` and `HEAD`; changed paths = keys whose value changed. Run `planAt(HEAD^1)` (A.4) with base `null` (every unit affected) and `all: true`, under the branch rule of `--branch` (default as for `plan`). `E_CAP`/`E_CAP_BASE` from the plan become a skip with reason `cap`, exit 0, so the shadow job does not fail on a policy error.
- **Compare:** for each changed path, tallyrelease `next` of the unit with that `path` vs the manifest's new value (`match` / `mismatch`). Also report `tallyrelease-only` (a unit with a `next`, path not changed) and `rp-only` (changed path, no tallyrelease `next` or no unit). Labels on non-`match` rows name a known divergence class only when it explains the direction of the difference; they never change the status:
  - `release-config`: a manifest path without a released unit, or a `tallyrelease-only` unit missing from the manifest.
  - `dependent-patch`: release-please `node-workspace` or tallyrelease propagation released a patch alone. `rp-only` rows whose new value is exactly the patch bump of the old one and whose unit depends on a unit with a changed manifest path; `tallyrelease-only` rows with `propagatedFrom` whose `next` is exactly the patch bump of `from`. Never on `mismatch`.
  - `absorbed-internal`: tallyrelease is higher (`tallyrelease-only`, or `mismatch` with `next` above the manifest value) and the unit has an absorbed change (`via`) that is breaking or has a type in `bumps.types`.
  - `group-vs-rp`: the unit is in a fixed group.
  - `separate-pr`: a `tallyrelease-only` row while `separate-pull-requests` is set in `release-please-config.json` (`--rp-config`) for that package, else at the top level; the unit's own release PR is still open.
  - `squash-split`: release-please is higher (`rp-only`, or `mismatch` with the manifest value above `next`) and a commit of the unit since its base tag would be split by release-please (`splitMessages`): a blank line followed by `(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.*?\))?: `, or `BEGIN_NESTED_COMMIT`. tallyrelease keeps one Change per commit.
  - `stale-rp-pr` stays a manual label in the tracking issue.
- **Report** (`--out`, schema 1): `{ schema, tool, pin, sha, replay, branch, head, planned, manifest, skipped, rows, warnings }`. `pin` is `--pin` (the exact cli version, since `tool` is `tallyrelease@0.0.0`), `sha` is `GITHUB_SHA`, `replay` is true with `--head` or when `head` is not `GITHUB_SHA`, `planned` is `HEAD^1`, `skipped` is `null` or `{ reason: "manifest" | "cap", message }`. Rows `{ path, unit, status, before, after, from, next, labels }` are sorted by path; `before`/`after` are the manifest values at `HEAD^1`/`HEAD`, `from`/`next` tallyrelease's. A manifest that is not a JSON object of strings, or a release-please config that is not a JSON object, is `E_SHADOW_INPUT`; an explicit `--manifest` or `--rp-config` missing at `HEAD` warns `W_SHADOW_INPUT_MISSING`.
- **Evidence:** job summary table (`--summary`), `::warning` annotations per unlabelled row on GitHub Actions, the report uploaded as an artifact, and one tracking issue per repo listing every comparison run, plus a counts-only gate issue in this repository. `--strict` exits 1 (`E_SHADOW_MISMATCH`) on any unlabelled non-`match` row. Each repo runs a standalone push-only job; consumers pin an exact cli version with `--pin`.
- **Where it runs:** in app-stack the `Release plan` job runs `plan --summary` and, in `shadow` mode, `shadow`; the standalone push-only job (A.11) stays in this repo only. After a switch (`tallyrelease: release`) the manifest no longer changes, so shadow skips with reason `manifest`.
- **Gate to v0.3 switch:** at least 10 compared stable unit releases combined, at least 3 from groundwork or launchpad-mono, at least 2 weeks of live shadow runs in each repo that releases in the window, zero unexplained mismatches. Replays never count; before `--strict`, every live-observed release is replayed with the final `0.2.0` and any change explained. This repo's `tallyrelease.yaml` sets `defaults.propagate: patch` and `initialVersion: 0.1.0` and a `main` rule with channel `beta` (mirroring release-please `node-workspace`, `bump-minor-pre-major` and `initial-version`).

---

## C. Milestones

Conventions: tests prefer fakes at seams over module mocks (no `vi.mock` of modules, no `vitest-mock-extended`). Core scenarios are YAML in `packages/core/test/scenarios/` describing config, plugin stubs and a commit DAG served by `memoryGit`. Most cli integration scenarios call `main(argv, deps)` in-process with `memoryGit`, `memoryFs` and `fakeForge` (records calls, serves canned runs and PRs). Effects (v0.3) use a `memoryRemote` state shared by `fakeForge` and a fake `GitWriter` (pushed branches, commits with their files, tags, PRs, releases); `memoryGit` is never mutated: a run sees the dag's tags plus the remote's, and a merge is simulated by a new dag with the PR's files on top and a fresh `memoryRepo`. `gitReaderConformance(makeReader)` runs against `memoryGit` and the real reader. A few scenarios use real git in tmp repos: G07 (shallow), G10 (yarn e2e), G11 (php e2e), G16 (conformance), G29 (local merge base), E30 (git writer with a bare origin). The GitHub forge adapter has one spec against a local `node:http` server via its `baseUrl` (`GITHUB_API_URL`). Harnesses stay small.

### v0.1: `affected` (release-please still owns versions)

| #   | Task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Acceptance criteria                                                                                                                                                                                                                                                                    |
| :-- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scaffold the repo from the service template (no self-check job yet); core/cli export a version constant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `yarn install --immutable`, `yarn check` (incl. `check:purity`), `yarn build`, `yarn test-unit`, `yarn turbo test-integration` pass locally and in CI; `test/purity.spec.ts` green.                                                                                                    |
| 2   | Core contract, `memoryGit`, `discoverUnits`, `buildGraph`, attribution, `computeAffected`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Core scenarios below green; public types and `./testing` exported.                                                                                                                                                                                                                     |
| 3   | `node` plugin (public API only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Specs: yarn/npm/pnpm discovery, single-package repo, pinning table (A.7.7), default global inputs, `meta.node.packageName`.                                                                                                                                                            |
| 4   | `php` plugin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Specs: single repo unit `.` with repo-name id, path-repo monorepo, `require` edges, `composer.lock` global input, no version files.                                                                                                                                                    |
| 5   | Cli: `main(argv, deps)`, config load, `GitReader` (passes `gitReaderConformance`), minimal `Forge` (`lastSuccessfulPushRuns`) + GitHub adapter + `fakeForge`, build base, `check`, `graph`, `affected`, outputs. Write this repo's `tallyrelease.yaml` (`node`, overlays `packages/core: { id: core, release: true }`, `packages/cli: { id: cli, release: true }`; the tag format is adjusted to match release-please component tags after the first release). Add `self-check` job: `permissions: { contents: read, actions: read }`, `env: GITHUB_TOKEN: ${{ github.token }}`, checkout `fetch-depth: 0`, build, `tallyrelease check`, `tallyrelease affected --github-output`. | Integration scenarios below green; `--json` validates against `affected.schema.json`; self-check job green on a PR and on `main`; on `main`, `base-source` is `forge-last-success` or `push-before` and `W_NO_FORGE` is absent.                                                        |
| 6   | Release 0.1.0 via release-please and npm. In `abinnovision/actions` (separate repo): `run-tallyrelease` action and M2a. Sandbox `abinnovision/tallyrelease-sandbox-yarn` (E9): `packages/ui`, `apps/web` (depends on ui `workspace:^`), `apps/api`; `.github/workflows/ci.yaml` calls app-stack from the M2a branch with `build-selection: affected`.                                                                                                                                                                                                                                                                                                                             | `affected-paths` is ordered by unit id; prune/pack matrix entries equal it as a set. Push touching `packages/ui/src/button.ts`: `packages/ui`, `apps/web`. Touching `apps/api/src/main.ts`: `apps/api`. Touching `yarn.lock`: all three, `all=true`. Touching only `README.md`: empty. |

Core scenarios (plus `gitReaderConformance(memoryGit)`): `A01-direct-single`, `A02-dependent-via`, `A03-transitive-diamond-dedupe`, `A04-global-input-lockfile`, `A05-ignore-only-change`, `A06-unattributed-reported`, `A07-nested-roots-deepest-wins`, `A08-rename-across-units`, `A09-version-none-included` (unreleased units are affected), `A10-null-base-all`, `A11-cycle-closure-warns`, `A12-tallyrelease-yaml-global-input`, `A13-custom-config-file-global-input`, `A14-glob-metacharacters-in-root`, `C01-duplicate-unit-id`, `C02-duplicate-root`, `C03-edge-unknown-unit`, `C04-edge-dedupe-pinned-or`, `C05-api-version-rejected`, `C06-config-only-unit-and-deps`, `C07-meta-namespaced`, `C08-plugin-options-invalid`, `C09-global-inputs-disabled-per-plugin`, `C10-root-overlay-default-id` (root overlay without id creates unit with repo-name id; absorbs otherwise unattributed files; root `package.json` still global), `C11-plugin-options-global-inputs-stripped`, `C12-root-missing` (`E_ROOT_MISSING`), `C13-plugin-hook-error`, `C14-edge-self`, `C15-plugin-unknown`, `C16-unit-id-dot`, `C17-root-invalid`, `C18-root-normalized`, `C19-default-not-released`, `C20-release-opt-in-uses-plugin-source`, `C21-defaults-release-with-opt-out`, `C22-overlay-version-source-override`, `C23-config-only-unit-released-tag`.

Cli integration: `G01-push-before`, `G02-zero-before-forge-fallback`, `G03-zero-before-no-token-all`, `G04-pr-merge-base`, `G05-merge-group-base`, `G06-force-push-falls-through`, `G07-shallow-missing-base-error` (uses `--is-shallow-repository`, also inside a linked worktree), `G08-cli-base-override`, `G09-github-output-format`, `G10-yarn-monorepo-e2e`, `G11-php-single-repo-e2e`, `G12-check-reports-errors-exit-1`, `G13-cancelled-pending-run` (P1 success, P2 run cancelled, P3 run: base = P1, units from P2 included), `G14-github-forge-local-http`, `G15-no-last-success-uses-before` (token present, no successful run: base = `before`, `W_NO_LAST_SUCCESS`), `G16-git-reader-conformance` (real reader passes `gitReaderConformance`), `G17-config-version-none-rejected` (`E_CONFIG` with hint `use release: false`), `G18-check-lists-released-units` (including the `0 released` form), `G19-graph-formats` (`--format text|mermaid|json`: text table and tree, `dependents` omitted without edges, `no units`; `--json` conflict and unknown format exit 2), `G28-affected-text-and-tsv` (grouping, `global` changed line, `released` marker, every base label, summary plurals, TSV, `--json --format tsv` exits 2), `G29-local-merge-base` (feature branch against `origin/HEAD`; `CI` and `JENKINS_URL` build everything; without a remote local `main` is the base; without `main`/`master` everything). G11 also asserts the `graph` version column.

### v0.2: planner + shadow

| #   | Task                                                                                                                                                                                                                                                                                           | Acceptance criteria                                                            |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------- |
| 1   | `semver` scheme, scheme registry, test-only flutter sketch scheme.                                                                                                                                                                                                                             | Scheme specs; `R21` passes using only the public `VersionScheme` and `PreCtx`. |
| 2   | `conventional-commits` intent source, in-core parser (`type(scope)!:`, `BREAKING CHANGE:`, `Release-As:`, squash `(#123)` -> `pr`).                                                                                                                                                            | Parser specs; `check:purity` still green.                                      |
| 3   | Tag matching (released units only), base and line-base tags, release set, absorption and propagation through unreleased units, fixed groups (`E_GROUP_NOT_RELEASED`, `E_GROUP_SCHEME`), branch rules, limits, channels, kinds, `W_RELEASE_AS_IGNORED`, `W_NO_RELEASED_UNITS`, `computePlan()`. | Core scenarios below green.                                                    |
| 4   | Cli `plan` (incl. `--head`, `--github-output`), `explain`, `plan.schema.json`.                                                                                                                                                                                                                 | Integration scenarios below green.                                             |
| 5   | `shadow` command (A.13); add `branches` and `defaults.propagate: patch` to this repo's `tallyrelease.yaml`; shadow jobs in this repo and the shadow consumer.                                                                                                                                  | Gate in A.13 met, evidence in the tracking issue; then enable `--strict`.      |

Core scenarios: `R01-two-feats-one-fix-prerelease`, `R02-n-stable-under-attribution-change`, `R03-premajor-breaking-minor`, `R04-release-as`, `R05-caret-dependent-rebuild-only`, `R06-exact-pinned-dependent-patch`, `R07-workspace-star-pinned`, `R08-fixed-group-shared-version-max`, `R09-fixed-group-prerelease-n-max`, `R10-maintenance-1x-after-2.0.0`, `R10b-maintenance-first-release-unchecked`, `R11-feat-on-patch-line-limit-error`, `R11b-release-as-above-limit`, `R11c-absorbed-minor-on-patch-line`, `R12-base-tag-skips-prerelease-and-unreachable`, `R13-merge-and-squash-commits`, `R14-no-base-tag-initial`, `R15-rebuild-vs-none-kinds`, `R16-branch-without-channel`, `R17-php-tag-only-release`, `R18-lockfile-only-no-bump`, `R19-channel-rule-checks`, `R20-cycle-propagation-fixpoint`, `R21-flutter-sketch-scheme` (incl. maintenance build above highest tagged build), `R21b-flutter-maintenance-cap`, `R22-no-branch-rule-warning`, `R23-maintenance-merged-back-n-monotonic`, `R24-tag-format-overlap-and-escaping`, `R25-monorepo-maintenance-relative-limit`, `R26-maintenance-absolute-single-unit`, `R26b-maintenance-absolute-minor`, `R26c-maintenance-absolute-implicit-unit`, `R27-channel-tokens`, `R28-peer-and-optional-pinning`, `R29-absorb-unreleased-dependency`, `R30-absorb-stops-at-released-unit`, `R31-absorbed-chore-no-bump`, `R32-tag-overlap-ignores-unreleased`, `R33-propagate-through-unreleased`, `R34-absorbed-breaking-patch`, `R35-absorb-dedupe-and-cycle`, `R36-absorbed-bump-in-fixed-group`, `R48-fixed-group-quiet-member`, `R49-fixed-group-by-tags`, `R50-fixed-group-joiner`, `R51-fixed-group-release-as-member`, `R52-fixed-group-propagates`, `R53-fixed-group-maintenance`, `R53b-fixed-group-maintenance-base`, `R53c-fixed-group-cap-commits-merge`, `R54-fixed-group-first-release`, `R57-fixed-group-member-values-max`, `R58-single-release-item-absolute`, `R59-fixed-group-release-as-below-bump`, `R61-fixed-group-flutter-scheme`, `R50b-fixed-group-member-own-range`, `R50c-fixed-group-equal-version-tie`, `R51b-fixed-group-release-as-only`, `R54b-fixed-group-initial-max`, `A15-group-couples-build-set`, `C26-group-unknown-unit`, `C27-group-overlap`, `C28-group-release-validation`, `C29-branch-rule-target`, `C29b-branch-rule-group-member`, `C29c-branch-rule-unknown-unit`, `C29d-branch-rule-unreleased-unit`, `R67-release-as-wins-over-propagation`, `R68-propagate-paths-or-combined`, `R69-propagate-from-release-as-only`, `R70-propagate-first-release`, `R71-absorbed-minor-mode`.

Cli integration: `G20-tags-merged-and-ranges`, `G21-first-parent-counts-with-merges`, `G22-maintenance-branch-from-tag`, `G23-shadow-match`, `G24-shadow-mismatch-strict-exit-1`, `G25-shadow-skips-non-manifest-push`, `G26-plan-schema-valid`, `G27-plan-github-output`, `G34-affected-group-reason`, `G36-shadow-fixed-group-first-release`, `G37-shadow-cap-skip`.

### v0.3: effects + switch

| #   | Task                                                                                                                                                                                              | Acceptance criteria                                                                                                                                                                                             |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Extend `Forge` (PRs incl. merged lookup, labels, refs, releases) and `fakeForge`.                                                                                                                 | Adapter spec against local HTTP server.                                                                                                                                                                         |
| 2   | Version file writes (node `package.json` version + pinned dependent ranges); idempotent changelog writer; `tallyrelease version`.                                                                 | `E01`.                                                                                                                                                                                                          |
| 3   | `release-pr` effect with re-read, tree-equality skip, `--force-with-lease`, body-hash skip; `tallyrelease pr`.                                                                                    | `E02`, `E03`, `E06`, `E10`.                                                                                                                                                                                     |
| 4   | Reconcile (A.12: plan equality via `planAt`, local tags + push, cache invalidation), `renderFloatingTags`, forge releases, `plan.released` from tags; `tallyrelease release`, `tallyrelease run`. | `E04`, `E05`, `E07`, `E09`, `E11`, `E12`, `E14`, `E15`, `E16`.                                                                                                                                                  |
| 5   | Release list v2 with `catchUp`, topological order.                                                                                                                                                | `E08`, `E13`; publishers accept v1 and v2, build `catchUp` entries from `releaseSha` outside the `affected-paths` filter, and treat already-published as success (actions repo).                                |
| 6   | Dogfood: this repo's `ci.yaml` runs `tallyrelease run --dry-run` from the previously published version, then switches to `tallyrelease run`; remove release-please files.                         | One full release cycle of `core` and `cli` by tallyrelease. Then actions M4a-M4d (A.11 orphan-commit note).                                                                                                     |
| 7   | Actions (`abinnovision/actions`, after cli 0.3.0): A1 publisher idempotence and git rule; A2 app-stack `tallyrelease: release` with `release-build`; A3 `run-tallyrelease` bundles cli 0.3.0.     | Sandbox runs: a release merge publishes from HEAD payloads; a skipped merge run is published from `releaseSha` and its tarball version equals the entry; re-runs end green; `off` and `shadow` lists unchanged. |

Cli integration: `E01-version-files-written`, `E02-release-pr-create-then-update-idempotent` (first push uses empty-lease `--force-with-lease`; body under 60,000 characters with 200 units; marker holds only `head`, `releaseCommit`, `releases`), `E03-empty-release-set-closes-pr`, `E04-merged-pr-tags-at-merge-sha`, `E05-stale-merge-refused-and-recovered` (no tags; next release PR has exactly one changelog section above the base tag; version files equal the new plan), `E06-rerun-noop-no-push-no-body-edit`, `E07-maintenance-make-latest-false`, `E08-release-list-v2-kinds`, `E09-merge-run-skipped-next-push-tags`, `E10-pr-body-race-rejected`, `E11-floating-tags-highest-only`, `E12-tag-exists-different-sha-error`, `E13-catch-up-entry-release-sha`, `E14-reconcile-then-plan-same-run` (tags created in reconcile appear in the same run's `plan.released` and base tags), `E15-merge-queue-ahead-noop-accepted` (main moved before merge without changing the release set: tagged), `E16-publish-failure-reemitted` (run after a failed run re-emits the release from tags).

0.3.1 (prerelease numbers from the unit's introduction): core scenarios `R79-prerelease-n-from-introduction`, `R79b-prerelease-n-introduced-by-merge`, `R79c-prerelease-n-root-unit-total`, `R79d-fixed-group-prerelease-n-oldest-introduction`, `R79e-prerelease-n-merged-tag-off-chain`; `gitReaderConformance` covers `introduced`; cli integration `G39-explain-introduction`.

0.4 (release list for publishers): core scenarios `C33-glob-overlay-basic`, `C33b-glob-overlay-order`, `C33c-glob-overlay-field-rejected`, `C33d-glob-overlay-double-star`, `C33e-glob-overlay-unmatched`, `A16-released-changelog-not-ignored`, `R80-release-at-head-in-build-set` and `R80b-release-at-head-outside-build-set`; cli integration `E37` (a tag-only unit released at HEAD under `ignore: ["**/*.md"]` is `catchUp: false` and in the build set).

**Rollout order**

1. tallyrelease tasks 1 to 5 and the dry-run canary; release 0.3.0 by release-please.
2. Actions A1, A3, A2; release app-stack with the opt-in mode.
3. This repo switches (task 6), then removes the release-please files after one full cycle. The gate (A.13) applies to consumer repos only.
4. launchpad-mono after the gate: `releasePr: separate` in `defaults`, `tallyrelease: release`.
5. groundwork: `tallyrelease.yaml` with group `groundwork`, `app-{id}-v{version}` and `defaults.initialVersion: 1.0.0`; the first release 1.0.0 is done by tallyrelease, without a bootstrap sha.
6. `abinnovision/actions` last (A.11 orphan-commit note, M4a to M4d); may land in 0.3.x.

**Switch checklist** (per consumer repo)

1. Gate met; the latest shadow report has zero unlabelled rows.
2. No release-please release PR merged but untagged.
3. `tallyrelease.yaml` has units, groups, `releasePr`, tag formats equal to the existing tags, `tags.floating` and `versionFiles` if used; `check` and `plan --all` show the expected `from` and `next`. For each pending unit with a channel, the highest prerelease published by release-please is below the plan's `version`; otherwise switch right after a stable release.
4. The caller workflow has workflow-level concurrency per branch without `cancel-in-progress` on pushes.
5. Workflows triggered by tag pushes are reviewed: tags pushed with the broker token trigger them. Release PRs opened with the broker token run PR CI on every rebuild (one per open release PR per push), as with release-please.
6. Every open `release-please--*` PR is closed manually with a comment and its branch deleted, so none can be merged afterwards. tallyrelease never changes release-please PRs.
7. `tallyrelease: release` is set in the app-stack call; the broker scopes include `actions:read` and `issues:read`; the `tallyrelease: pending|released|stale` labels exist (pre-create them if the token cannot).
8. First run: release PRs open with the expected versions and changelog sections above the last release-please section.
9. Merge one release PR; verify tags at the merge sha, GitHub releases, publishes and the release list in the run summary. After one full cycle remove `release-please-config.json`, `.release-please-manifest.json` and any `bootstrap-sha`.
10. Rollback: tallyrelease never updates `.release-please-manifest.json`, so switching back takes one manual commit setting every manifest entry to the version of the unit's latest tallyrelease tag (restore the release-please files from history with `git checkout <sha> -- <files>` if step 9 removed them); merge it, set `tallyrelease: off` and close open `tallyrelease: pending` PRs. Tags use the release-please names, so release-please continues from them.

### Later (no committed order)

`dart` plugin + `flutter` scheme + `changelog` plugin hook; `generic` (regex version files) + `markers`; linked groups; `calver`; `changesets` intent source; `go` with an additive `validate?(ctx, plan)` hook for the `/vN` module path rule; scope narrowing/forcing; Tier 3 npm plugin packages; standalone binary (SEA); `tallyrelease import release-please`.

---

## Purity rules

Core stays free of I/O so that `computePlan()` is deterministic and testable. Enforcement has three layers:

- Lint (`packages/core/eslint.config.ts`): `src/**/*.ts` (except specs) may not import Node builtins (`fs`, `path`, `os`, `child_process`, `net`, `http`, `https`, `http2`, `dgram`, `dns`, `tls`, `worker_threads`, `cluster`, `process`, `vm`) or `@tallyrelease/cli`, and may not use the globals `process`, `fetch`, `require`, `Buffer`.
- Types: core `tsconfig.build.json` sets `"types": []`.
- Bundle check: `check:purity` (`tools/check-purity.mjs`) bundles `src/index.ts` with esbuild for `--platform=neutral`. Any Node builtin import fails, including imports pulled in by dependencies, which lint cannot see. It runs in turbo `check` and CI. `test/purity.spec.ts` proves the check fails on a `node:fs` import (`test/purity/violation.ts`).

Built-in plugins in `packages/cli/src/plugins/**` use the public API only. Lint there forbids Node builtins, the same globals, and relative imports that leave `src/plugins/**`; plugins import only `@tallyrelease/core` and other plugin files.

---

## Decisions

| #   | Decision                          | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| :-- | :-------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Naming                            | Product `tallyrelease`, npm scope `@tallyrelease`. Packages `@tallyrelease/core` and `@tallyrelease/cli` (bin `tallyrelease`). Config `tallyrelease.yaml`. Labels `tallyrelease: *`, release PR branches `tallyrelease/release/<branch>/shared` and `tallyrelease/release/<branch>/<item>`.                                                                                                                                                                          |
| E2  | Second v1 plugin                  | `php`.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| E3  | Publish core separately from v0.1 | Yes. The cli depends on it at runtime; plugin authors need its types and `./testing`.                                                                                                                                                                                                                                                                                                                                                                                |
| E4  | Node engines                      | `>=24`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| E5  | Default `preMajor`                | `breaking: minor`, `feat: minor`; shadow consumers set it explicitly.                                                                                                                                                                                                                                                                                                                                                                                                |
| E6  | Shadow parity strategy            | Shadow with `propagate: patch`, switch to `auto` at cutover with a changelog note.                                                                                                                                                                                                                                                                                                                                                                                   |
| E7  | Repo visibility and licence       | Public, Apache-2.0.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| E8  | Release PR token                  | Plain `GITHUB_TOKEN` by default; `--token` overrides. PRs and tags created with `GITHUB_TOKEN` do not trigger workflows, so users who need checks on release PRs pass another token.                                                                                                                                                                                                                                                                                 |
| E9  | Sandbox repo                      | Later. The npm release, actions repo work and sandbox are outside v0.1 for now.                                                                                                                                                                                                                                                                                                                                                                                      |
| E10 | Shadow consumer                   | The owner picks later.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| E11 | Release opt-in                    | Units are build-only unless `release: true` (per unit or `defaults.release`). Plugins declare the version source (`file`/`tag`), config decides releasability; `Unit.version` stays the single effective value. Unreleased units are absorbed into released dependents (A.7.6), a deliberate divergence from release-please. Alternatives rejected: flipping `version` to default `none`, plugin heuristics such as `!private`, a top-level selector list.           |
| D9  | Release PR branches               | Always a leaf: the shared PR is `tallyrelease/release/<branch>/shared`, a separate PR `tallyrelease/release/<branch>/<item>`; the item name `shared` is reserved (`E_RELEASE_ITEM_NAME`). `releasePr: shared \| separate` per item (default `shared`); `E_RELEASE_PR_SPLIT_EDGE` guards patch-propagating edges between items in different PRs. A git ref cannot be both a file and a directory, hence no `tallyrelease/release/<branch>` next to separate branches. |
| D10 | Reconcile placement               | `tallyrelease: release` in app-stack replaces `run-release-please` in the `release` job, after `check` and `test`, so tags follow green CI. `off` and `shadow` stay unchanged.                                                                                                                                                                                                                                                                                       |
| D11 | Prerelease numbers                | From the plan: `<next>-<channel>.<N>`, `N` = first-parent commits since the line base, without one since and including the unit's introduction. Unique per commit, no registry lookup, never lower than release-please's count for the same `next` (without a line base, release-please counts unit commits since the introduction, a subset of the first-parent commits on squash histories).                                                                       |
| D12 | Changelog writer                  | One writer in core in release-please format (`## [<version>](<compare>) (<date>)`, sections, entries), no plugin writers in 0.3. The heading date is the UTC date the release PR is generated (injectable `clock`).                                                                                                                                                                                                                                                  |
| O1  | Dogfood before the gate           | This repo may switch before the shadow gate; the gate applies to consumer repos.                                                                                                                                                                                                                                                                                                                                                                                     |
| O2  | Token handling                    | The cli is token-agnostic (`--token` or `GITHUB_TOKEN`) and documents the permissions per command; abinnovision repos get the token from the broker in app-stack.                                                                                                                                                                                                                                                                                                    |
| O3  | Release list and catch-up builds  | Schema 1 plus optional `catchUp`, `releaseSha`, `tag`; app-stack builds catch-ups at `releaseSha` in `release-build`; publishers treat already-published as success; `latest` and dispatch follow the git rule (A.11).                                                                                                                                                                                                                                               |
| O4  | groundwork first release          | 1.0.0 is the first release done by tallyrelease: a fixed group without a base tag, explicit `defaults.initialVersion: 1.0.0`, no bootstrap sha.                                                                                                                                                                                                                                                                                                                      |
| O5  | Templated version files           | Unit overlay `versionFiles: [{ file, pattern }]` beside plugin version files; matches in `[from, next)` are replaced; the version string stays `0.0.0` until the owner decides.                                                                                                                                                                                                                                                                                      |
| O6  | release-please PRs at the switch  | No automatic changes; closing open `release-please--*` PRs is a manual checklist step.                                                                                                                                                                                                                                                                                                                                                                               |

---

## Risks and mitigations

| Risk                                                                                 | Mitigation                                                                                                                                                                                                                        |
| :----------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queued runs replaced by concurrency, under-building or losing releases.              | Build base takes `lastSuccess` when it is older than `before` (G13); every run reconciles all merged pending release PRs (E09); `plan.released` is derived from tags in `(base, HEAD]`, so failed publishes are re-emitted (E16). |
| Catch-up releases built from the wrong commit.                                       | `catchUp: true` + `releaseSha` in release list v2; publishers build those entries from `releaseSha` (actions task, gate for M4b).                                                                                                 |
| PR body or branch rewritten during merge.                                            | `releaseCommit` in marker, `pr.head.sha` check, re-read before push, `--force-with-lease` (E10 scenario).                                                                                                                         |
| Shadow mismatches by design.                                                         | Labelled divergence classes; `propagate: patch` during shadow; gate needs zero **unexplained** mismatches.                                                                                                                        |
| Repo forgets to opt units in; nothing releases.                                      | `check` lists released units; `W_NO_RELEASED_UNITS` (v0.2); shadow class `release-config`.                                                                                                                                        |
| Attribution surprises (shared root files).                                           | `globalInputs`, `ignore`, `unattributed`, `explain`.                                                                                                                                                                              |
| Plugin contract churn after publishing core.                                         | `apiVersion` gate; `PreCtx.tags` and `GitReader` settled before 1; changelog and validate hooks are additive later.                                                                                                               |
| Prerelease collisions.                                                               | Line-base `N` (R23); channel checks (R19, R27); force-push on line branches unsupported.                                                                                                                                          |
| Line branch fast-forwarded to a branch that merged main in.                          | Unsupported, like force-push: the first-parent chain changes, so the line base and `N` can drop. Merge into line branches instead.                                                                                                |
| Root of an untagged unit renamed.                                                    | The introduction moves to the rename, so `N` restarts. Documented, same class as fast-forwarding a line branch; a stable release resets the counter anyway.                                                                       |
| Member removed from an untagged group.                                               | The group counts the max over its members, so `N` can drop when the oldest member leaves. Documented.                                                                                                                             |
| Shallow clone.                                                                       | Every unit is introduced at the shallow boundary, the same class as `total` without a line base.                                                                                                                                  |
| Maintenance branch cut before any tag.                                               | It shares main's introduction; not a regression, as both count from the same commit.                                                                                                                                              |
| Duplicate publish on workflow rerun.                                                 | Same version recomputed; publishers treat "already published" as success (actions task).                                                                                                                                          |
| Hidden I/O in core dependencies.                                                     | `check:purity` neutral bundle in CI.                                                                                                                                                                                              |
| Release PR checks never run (`GITHUB_TOKEN` events).                                 | Documented; users who need checks pass another token with `--token`.                                                                                                                                                              |
| tallyrelease releasing itself breaks.                                                | release-please releases tallyrelease until v0.3; afterwards CI uses the previous published version.                                                                                                                               |
| Lost or duplicate releases during the switch.                                        | Switch checklist steps 2 and 6; `E_TAG_EXISTS` on a different sha; same-sha tags are a no-op, so a release-please tag at the same commit is harmless.                                                                             |
| Release merge with failing tests is published later from its own sha.                | Documented; fix forward with a new release; `release-build` builds the tagged content.                                                                                                                                            |
| Separate and shared PRs publish inconsistent pins or dependency releases.            | `E_RELEASE_PR_SPLIT_EDGE`.                                                                                                                                                                                                        |
| Re-running an old run rolls a deployment back or regresses open PRs.                 | Git rule for `latest` and dispatch (A.11); `W_PR_HEAD_BEHIND` is evaluated first.                                                                                                                                                 |
| A replaced queued release run leaves its release undeployed.                         | Catch-up entries that are the newest version of their unit are dispatched.                                                                                                                                                        |
| Two versions of one unit in one list break name-keyed publishers.                    | Every version is published; `version_map` per artifact in `publish-npm`; `publish-linear` keeps the highest per access key.                                                                                                       |
| Re-run of an old failed publish takes `latest` after a newer release.                | Documented; the next run re-emits failed releases with a fresh `latest`.                                                                                                                                                          |
| A merged release PR not yet visible lets a run succeed past it.                      | The issues API label listing is not search-indexed, and `released` is united with this run's reconciled tags; fallback guard on a positive signal if it ever happens.                                                             |
| A run stays red on `E_BASE_REQUIRED`.                                                | Stuck-run recovery (A.11).                                                                                                                                                                                                        |
| A forge error yields a null base and drops failed publishes.                         | `E_BASE_REQUIRED` in `release` and `run`.                                                                                                                                                                                         |
| Rollback to release-please reads a stale manifest.                                   | Checklist step 10.                                                                                                                                                                                                                |
| Broker-token tags and release PRs trigger more workflows than before.                | Checklist step 5; release-please parity.                                                                                                                                                                                          |
| A prerelease published by release-please has the same version as a new plan version. | Squash repos cannot collide; checklist step 3 for merge-commit repos.                                                                                                                                                             |
| Token scopes or rulesets block tag or branch pushes.                                 | Permissions per command (A.11); write scopes validated in this repo before consumers switch.                                                                                                                                      |
| Separate PR churn (one force-push per open PR per push).                             | Accepted, release-please parity.                                                                                                                                                                                                  |
| Duplicate `Authorization` header when checkout persisted credentials.                | Header reset before the token header is set; `persist-credentials: false` recommended.                                                                                                                                            |
| Prerelease numbers change visibly (D11).                                             | The new `N` is never lower for the same `next`; documented.                                                                                                                                                                       |
| OCI tags overwritten or rejected on re-run.                                          | Existence probe on `<image>:<version>` in `publish-oci`.                                                                                                                                                                          |
| Self-release breaks this repo's release.                                             | 0.3.0 is released by release-please; CI then uses the published 0.3.0; dry-run canary first; rollback to `off` while release-please files remain.                                                                                 |
| Floating `app-stack-v1` ships behaviour to every repo.                               | `release` is opt-in; `off` and `shadow` lists are byte-identical; `run-tallyrelease` pins an exact cli.                                                                                                                           |
| Squash commit body carries footer-like lines.                                        | Release commit body lines never start with `Token:`; the marker is an HTML comment.                                                                                                                                               |
| Historical releases re-emitted without a base.                                       | `W_RELEASED_NO_BASE`, HEAD-only.                                                                                                                                                                                                  |
| `release-build` is a second build path at an arbitrary sha.                          | Same anchored steps as `check` except its own checkout at `matrix.sha`; the sandbox run checks the tarball version.                                                                                                               |
| Changelog order differs from release-please.                                         | Byte parity checked on real history.                                                                                                                                                                                              |

---

## ADR

**Decision.** Build `tallyrelease` as two packages (pure `core`, imperative `cli`) with a versioned plugin contract from day one. Core reads files and git only through injected `ReadonlyFs` and `GitReader`. Ship build selection (`affected`) first, then the versioning planner validated in shadow mode against release-please, then effects (release PR, tags, floating tags, forge releases) and the switch. Built-ins `node` and `php` use only the public API. Every run reconciles from durable facts (tags, first-parent history, PR state).

**Drivers.** Migration risk for existing consumer repos; determinism and testability; reaching PHP/Flutter without core changes.

**Alternatives considered.** single package; full planner first; shadow first; `generic` as second plugin; cli-side hook invocation with precomputed git facts; green refs for build base; `before`-only build base; attributed-commit or reachable-base prerelease counter; commit trailers and input hash for merge detection; HEAD-only merge detection; strict first-parent stale check; label-driven publishing; absolute branch-pattern caps.

**Why chosen.** Two packages give a hard purity boundary at minimal cost, backed by lint, `types: []` and a neutral bundle. `GitReader` injection makes `computePlan()` one call and lets scenarios describe real DAGs. `affected` first delivers build selection with zero versioning risk. `php` stresses tag-only versioning. Durable reconciliation (lastSuccess vs `before`, merged-pending PR lookup, `releaseCommit` and plan-equality checks, `plan.released` from tags) survives cancelled runs, merge queues, races and failed publishes. Line-base `N` stays monotonic across maintenance merge-backs; relative limits keep monorepo maintenance lines usable.

**Consequences.** Core is async; `memoryGit` must model first-parent ancestry. Two integration passes in `abinnovision/actions`, plus a publisher change for `catchUp` entries. Every push run makes one forge call for the base. cli is a large package until split. release-please and tallyrelease run side by side through v0.2; from v0.3 each repo switches on its own.

**v0.3 addendum.** Effects live in the cli over pure core pieces (changelog writer, release items, marker). Release commits are built on a temporary index without a checkout (identity from `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, default `tallyrelease <tallyrelease@users.noreply.github.com>`; HEAD's committer date) and pushed with `--force-with-lease`. Release PR branches are always leaves (D9). Tags are the record of releases; `plan.released` comes from tags in `(build.base, HEAD]`. In app-stack, entries not built at HEAD are built at `releaseSha` by `release-build`, the list stays schema 1, and `latest` and dispatch follow the remote git tags (A.11). Rejected: schema 2 with per-publisher catch-up builds, catch-ups built from HEAD, a `--` branch separator, marker v2, reconcile in `configure` or on `pull_request: closed`, assembling the list in jq, a checked-out release branch, GraphQL `createCommitOnBranch`, registry lookups for `latest` or prerelease numbers.

**Follow-ups.** Split cli when a second consumer appears; Tier 2/3 plugin loading; `dart`/`flutter` with `changelog` hook; `generic`; linked groups; `calver`; `changesets`; `go` with `validate` hook; SEA binary; release-please importer; SchemaStore registration for `tallyrelease.yaml` (the schema is already published).
