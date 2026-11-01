# Plugin authoring guide

A plugin teaches tallyrelease about an ecosystem: where its units live, how they depend on each other, where their versions are written and, optionally, how versions are numbered or where release intent comes from. `node`, `php` and `kustomize` are built in. Anything else is a plugin you write, either as a file in your repository or as an npm package.

This guide covers the contract, testing, distribution, the trust model and purity. [configuration.md](configuration.md) lists every config key and [errors.md](errors.md) every error code. Plugin API version 1 is in beta like the rest of tallyrelease: until 1.0, a minor release may change it.

## What a plugin does

A plugin is an object built with `definePlugin` from `@tallyrelease/core`. Every hook is optional; implement the ones your ecosystem needs.

| Hook           | Returns                         | Purpose                                                                   |
| :------------- | :------------------------------ | :------------------------------------------------------------------------ |
| `options`      | a Standard Schema               | Validates `plugins.<name>` in the config.                                 |
| `discover`     | `UnitDraft[]`                   | Finds the units of the repository.                                        |
| `edges`        | `EdgeDraft[]`                   | Declares which unit depends on which.                                     |
| `inputs`       | `{ global?: string[] }`         | Globs of files that affect every unit.                                    |
| `versionFiles` | `VersionFile[]`                 | Reads and rewrites the version of a released unit that lives in a file.   |
| `schemes`      | `Record<string, VersionScheme>` | Adds version schemes next to the built-in `semver`.                       |
| `intent`       | `IntentSource[]`                | Adds sources of changes next to the built-in Conventional Commits source. |

Hooks run one at a time in config order and must return the same result for the same inputs. A hook that throws fails the command with `E_PLUGIN_HOOK`, which names the plugin and the hook.

## A minimal plugin

This plugin treats every `apps/*/app.json` as a unit, reads dependencies from a `uses` list and writes the version back to the same file.

`tools/apps-plugin.ts`:

```ts
import { definePlugin, PLUGIN_API_VERSION } from "@tallyrelease/core";
import { z } from "zod";

import type { Ctx } from "@tallyrelease/core";

const options = z.object({ dir: z.string().default("apps") });

interface Manifest {
  version?: string;
  uses?: string[];
}

const readManifest = (ctx: Ctx, root: string): Manifest =>
  JSON.parse(ctx.fs.read(`${root}/app.json`) ?? "{}") as Manifest;

export default definePlugin({
  apiVersion: PLUGIN_API_VERSION,
  name: "apps",
  options,
  discover: (ctx) =>
    ctx.fs
      .glob([`${ctx.options.dir}/*`], { dirs: true })
      .filter((root) => ctx.fs.exists(`${root}/app.json`))
      .map((root) => ({
        id: root.split("/").at(-1) ?? root,
        root,
        version: "file",
      })),
  edges: (ctx, units) =>
    units
      .filter((unit) => unit.plugin === "apps")
      .flatMap((unit) =>
        (readManifest(ctx, unit.root).uses ?? []).map((from) => ({
          from,
          to: unit.id,
          reason: "app.json uses",
          pinned: false,
        })),
      ),
  versionFiles: (_ctx, unit) => [
    {
      path: `${unit.root}/app.json`,
      read: (content) => (JSON.parse(content) as Manifest).version,
      write: (content, next) =>
        `${JSON.stringify({ ...(JSON.parse(content) as Manifest), version: next }, null, 2)}\n`,
    },
  ],
});
```

`tallyrelease.yaml`:

```yaml
plugins:
  apps: { path: tools/apps-plugin.ts, dir: apps }
units:
  apps/api: { release: true }
```

```text
$ tallyrelease graph
UNIT  PATH      PLUGIN  RELEASE
api   apps/api  apps    file
web   apps/web  apps    -

dependents
api
└── web

2 units (1 released), 1 edge
```

Things the example relies on:

- The config key is the plugin name. `plugins.apps` loads the module and requires its `name` to be `apps`.
- The module must have a default export. A named export is not found and fails with `E_PLUGIN_LOAD`.
- `edges` receives the units of all plugins, so filter on `unit.plugin` to read only your own manifests.
- `version: "file"` says the unit's version lives in a file. Whether a unit is released is decided by the config (`release: true`), never by a plugin.
- `dir` is a plugin option. `path` and `globalInputs` are removed before the options are validated, so the schema sees only `{ dir: "apps" }`.
- The plugin imports `@tallyrelease/core` and `zod`, which are resolved from your repository. Install what you import as dev dependencies, using the same `@tallyrelease/core` version as the cli.

## The contract

All names below are exported from `@tallyrelease/core`. [`packages/core/src/plugin.ts`](../packages/core/src/plugin.ts) is the source of truth.

### Definition

`definePlugin(plugin)` checks the plugin and returns it unchanged.

- `apiVersion` must equal `PLUGIN_API_VERSION` (currently `1`), else `E_PLUGIN_API`.
- `name` must match `^[a-z][a-z0-9-]*$`, else `E_PLUGIN_NAME`. The name `core` is reserved.

### Context

Every hook receives a frozen `Ctx`:

| Field     | Meaning                                                                                                                           |
| :-------- | :-------------------------------------------------------------------------------------------------------------------------------- |
| `options` | The validated options of `plugins.<name>`, or the raw object when the plugin has no `options` schema.                             |
| `repo`    | `{ name }`: the repository name.                                                                                                  |
| `fs`      | `ReadonlyFs`: `read(path)` (UTF-8 or `undefined`), `exists(path)` and `glob(patterns, { dirs? })`. Paths are repo-relative POSIX. |
| `log`     | `warn(msg)` adds a `W_PLUGIN` warning to the output. `debug(msg)` prints with `--verbose`.                                        |

`glob` returns sorted matches and skips `.git`, `node_modules` and the top-level `vendor`. `defaultUnitId(root, repoName)` gives the conventional id of a root: the repo name for `.`, else the last path segment.

### Options

`options` is any [Standard Schema](https://standardschema.dev) (zod, valibot, ArkType and others), and its output type becomes the type of `ctx.options`. It validates `plugins.<name>` without the keys core and the cli own: `globalInputs`, `path` and `package`. Failures raise `E_PLUGIN_OPTIONS`. Set `globalInputs: false` on a plugin entry to drop that plugin's default global inputs.

### Units and edges

`discover` returns `UnitDraft` objects: `id` and `root` are required; `include`, `exclude`, `version` (`file` or `tag`, default `tag`), `scheme`, `tagFormat` and `propagate` fill in defaults that the config overlay `units.<root>` can override field by field. `meta` is stored at `unit.meta[plugin.name]` for your other hooks to read. Duplicate ids or roots fail with `E_DUPLICATE_UNIT` and `E_DUPLICATE_ROOT`.

`edges` returns `{ from, to, reason, pinned }`, meaning `to` depends on `from`. Set `pinned` when the published manifest of `to` changes with the version of `from`; the propagation policy uses it. Edges from all plugins and `deps` in the config are merged and deduplicated.

### Version files

`versionFiles(ctx, unit)` is called lazily, only for units of the plugin that are released with `version: file`. Each entry gives a `path`, a `read(content)` that returns the current version (or `undefined`) and a `write(content, next, ctx)` that returns the new content. `WriteCtx` carries `unit`, all `units` and the planned `versions` (unit id to version). The built-in `node` plugin uses them to rewrite pinned dependency ranges. A path may belong to only one unit, else `E_VERSION_FILE_CLAIM`.

### Schemes

A `VersionScheme<V>` parses, formats, compares and bumps versions. A plugin registers schemes by name and units opt in with `scheme`. `semver` is built in and reserved. `release` and `prerelease` receive a `PreCtx` with git-derived data (`head`, `baseTag`, `tags`, `firstParent`), for example to derive a build number. Duplicate scheme names fail with `E_SCHEME_CLASH`. [`packages/core/test/fixtures/flutter.ts`](../packages/core/test/fixtures/flutter.ts) is a complete example.

### Tag helpers

A plugin that sets `tagFormat` can use the same rules core applies. `compileTagFormat(format, unitId)` throws `E_TAG_FORMAT` unless `{version}` occurs exactly once and returns a `TagFormat` whose `match(tag)` gives the `{version}` part. `renderTag(unit, version)` renders the tag of a version.

```ts
import { compileTagFormat, renderTag } from "@tallyrelease/core";

compileTagFormat("{id}-v{version}", "web").match("web-v1.2.0"); // "1.2.0"
renderTag({ id: "web", tagFormat: "{id}-v{version}" }, "1.2.0"); // "web-v1.2.0"
```

### Intent sources

An `IntentSource` has a `name` and `collect(ctx, { from, to, commits })` that returns `Change[]`. Core always runs the Conventional Commits source (`parseCommit` is exported for plugins that read commit messages). A source can attribute a change through a commit (`sha`, by the files it touched) or explicitly (`units`).

## Testing

`@tallyrelease/core/testing` provides in-memory fakes, so a plugin test needs no repository and no mocks:

- `memoryFs(files)` is a `ReadonlyFs` over a map of path to content.
- `memoryCtx({ options, repo, files })` is a `Ctx` over `memoryFs`. It collects `log.warn` messages in `warnings` and does not run the `options` schema, so pass options in their validated form.
- `memoryGit(dag)` is a `GitReader` over a commit graph. Use it to produce `RawCommit`s with `log` for an intent source or to test anything that reads history.

`tools/apps-plugin.spec.ts`, run with vitest:

```ts
import { loadWorkspace } from "@tallyrelease/core";
import { memoryCtx, memoryFs } from "@tallyrelease/core/testing";
import { describe, expect, it } from "vitest";

import plugin from "./apps-plugin.ts";

import type { Plugin } from "@tallyrelease/core";

const files = {
  "apps/web/app.json": '{ "uses": ["api"] }',
  "apps/api/app.json": '{ "version": "1.0.0" }',
  "apps/notes.txt": "not an app",
};

describe("apps plugin", () => {
  it("discovers the directories holding an app.json", async () => {
    const ctx = memoryCtx({ options: { dir: "apps" }, files });

    expect(await plugin.discover?.(ctx)).toEqual([
      { id: "api", root: "apps/api", version: "file" },
      { id: "web", root: "apps/web", version: "file" },
    ]);
  });

  it("builds the graph through loadWorkspace", async () => {
    const workspace = await loadWorkspace({
      config: { plugins: { apps: null } },
      plugins: [plugin as Plugin],
      fs: memoryFs(files),
      repo: { name: "demo" },
    });

    expect(workspace.graph.edges).toMatchObject([{ from: "api", to: "web" }]);
  });
});
```

Call a hook directly to test one rule, and `loadWorkspace` to test the plugin as core runs it (option validation, unit merging, the graph). `loadWorkspace` takes `Plugin`, which a plugin with an `options` schema does not satisfy without the cast.

`memoryGit` feeds an intent source its commits:

```ts
import { memoryCtx, memoryGit } from "@tallyrelease/core/testing";

const git = memoryGit({
  commits: [
    { id: "a", message: "docs: readme", files: { "README.md": "1" } },
    { id: "b", message: "fix: login", files: { "apps/web/app.json": "{}" } },
  ],
});
const commits = await git.log(null, "HEAD");
// `source` is the IntentSource under test
const changes = await source.collect(memoryCtx(), {
  from: null,
  to: "HEAD",
  commits,
});
```

`@tallyrelease/core/testing/conformance` ships shared specs and requires vitest. `schemeConformance(scheme)` checks that a `VersionScheme` round-trips, orders and bumps consistently; run it on every scheme you add:

```ts
import { schemeConformance } from "@tallyrelease/core/testing/conformance";
import { describe } from "vitest";

import { flutter } from "./flutter.ts";

describe("flutter", () => {
  schemeConformance(flutter);
});
```

`gitReaderConformance(makeReader)` is for implementations of `GitReader` and is not needed for plugins.

## Distribution

A plugin is loaded from the config, by the key under `plugins`. The cli resolves each key in this order:

1. A built-in plugin of that name (`node`, `php`, `kustomize`). Built-ins cannot be replaced: setting `path` or `package` on one fails with `E_PLUGIN_LOAD`.
2. `plugins.<name>.path`, a local plugin.
3. `plugins.<name>.package`, an npm package. `path` and `package` exclude each other.

A key that matches none of these fails with `E_PLUGIN_UNKNOWN`. Only listed plugins run. In all cases the module must export a plugin whose `name` is the config key, and an unsupported `apiVersion` fails with `E_PLUGIN_API`.

### Local plugins

```yaml
plugins:
  apps: { path: tools/apps-plugin.ts }
```

`path` is a `.ts` or `.js` file relative to the repository root. A path that leaves the repository fails with `E_PLUGIN_LOAD`. The file is loaded with [jiti](https://github.com/unjs/jiti), so TypeScript needs no build step, and it can import sibling files. jiti keeps no disk cache, so what runs is always the file in the checkout. See the [trust model](#trust-model) before using local plugins in CI.

### npm packages

```yaml
plugins:
  apps: { package: "@acme/tallyrelease-apps" }
```

`package` is an npm package name that is installed in the `node_modules` of the repository root, for example as a dev dependency, and imported from there. Publish compiled JavaScript with an entry in `exports` and a default export of the plugin. List `@tallyrelease/core` as a peer dependency, since the cli checks `apiVersion` rather than the package version. Packages are not gated like local plugins: installing one is the decision to trust it, and your lockfile pins it.

## Trust model

A plugin is code that runs inside the cli with the permissions of the job. A local plugin is code from the checked-out branch, so a pull request can change it.

- `pr`, `release`, `run` and `version` hold write tokens and push, tag and create releases. They load local plugins only when you opt in with `--allow-local-plugins` or `TALLYRELEASE_ALLOW_LOCAL_PLUGINS=true`. Without it they fail with `E_PLUGIN_LOCAL`.
- Even with the opt-in, they never load local plugins on a pull request head: on `pull_request`, `pull_request_target` and `merge_group` events, or with a `GITHUB_REF` under `refs/pull/`.
- `check`, `graph`, `affected`, `plan`, `explain` and `shadow` do load local plugins on any ref. Run them without secrets and write tokens on code you do not trust, and in particular do not run them from a `pull_request_target` job that checked out the pull request head.
- `plugins.<name>.package` is not gated. For untrusted contexts, such as release jobs on repositories that accept outside contributions, publish the plugin as a package and pin it in the lockfile, so that the code that runs is not editable from a pull request.

Allow local plugins only in jobs that run on trusted branches:

```yaml
on:
  push:
    branches: [main]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: npx tallyrelease run --allow-local-plugins
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

See [E_PLUGIN_LOCAL](errors.md#e_plugin_local) and [E_PLUGIN_LOAD](errors.md#e_plugin_load).

## Purity

tallyrelease plans releases from a repository state, and the same state must give the same plan. Core therefore does no I/O: it reads files and git only through the injected `ReadonlyFs`, `Ctx` and `GitReader`. Plugin code follows the same rule.

- Read files only through `ctx.fs`. The cli binds it to the commit being planned, which can differ from the working tree: the planner also reads the base of a diff. A plugin that reads the working tree with `node:fs` would see the wrong files for those commits and give different answers on different machines.
- Do not run commands, call the network, or read the clock or the environment in a hook. Take such input from the config, as an option.
- Return a result that depends only on `ctx` and the other arguments. Hooks are awaited sequentially in config order.
- Report problems with `ctx.log.warn` when the run can continue, and throw an `Error` with a clear message when it cannot. A thrown error surfaces as `E_PLUGIN_HOOK` with the plugin and hook name.

Core enforces its side with lint and a bundle check. The cli does not enforce the rule for loaded plugins. The built-ins in [`packages/plugins/src`](../packages/plugins/src) (package `@tallyrelease/plugins`) are worked examples that obey it: lint there forbids Node builtins, `@tallyrelease/cli` and imports outside `@tallyrelease/core` and the package. Their `_kit/` folder holds shared helpers and is internal, not an API; copy what you need instead of importing it.

## Troubleshooting

| Code                                             | Meaning                                                             |
| :----------------------------------------------- | :------------------------------------------------------------------ |
| [`E_PLUGIN_LOAD`](errors.md#e_plugin_load)       | Missing file or package, import error, wrong export name, built-in. |
| [`E_PLUGIN_LOCAL`](errors.md#e_plugin_local)     | A privileged command refused a local plugin.                        |
| [`E_PLUGIN_API`](errors.md#e_plugin_api)         | The plugin's `apiVersion` is not supported by this cli.             |
| [`E_PLUGIN_NAME`](errors.md#e_plugin_name)       | The plugin name is invalid or reserved.                             |
| [`E_PLUGIN_OPTIONS`](errors.md#e_plugin_options) | `plugins.<name>` fails the `options` schema.                        |
| [`E_PLUGIN_UNKNOWN`](errors.md#e_plugin_unknown) | A `plugins` key has no built-in, `path` or `package`.               |
| [`E_PLUGIN_HOOK`](errors.md#e_plugin_hook)       | A hook threw; the message names the plugin and the hook.            |
| [`W_PLUGIN`](errors.md#w_plugin)                 | A plugin called `ctx.log.warn`.                                     |

Run `tallyrelease check` to validate the config, plugins, units and graph, and add `--verbose` for debug output.
