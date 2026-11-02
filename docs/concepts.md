# Concepts

The running example is an npm workspaces monorepo with the released apps `api` and `web` and the build-only package `db`, which `api` depends on.

## Units

A unit is something you build and may release. It has an id, a root directory, an owning plugin and the files it owns (`include` and `exclude` globs, by default everything under its root except nested units). Plugins discover units: the node plugin reads the `workspaces` of `package.json`, so `apps/api`, `apps/web` and `packages/db` become the units `api`, `web` and `db`. The id is the last path segment of the root, or the repository name for a unit at the root (`.`).

The keys of `units` are root paths. A key that no plugin discovered creates a config-only unit (see [plugins/config-only.md](plugins/config-only.md)). A key with `*` is a glob over unit roots: `*` matches exactly one path segment and skips directories starting with `.`. Globs apply in declaration order, exact keys win over them field by field, and `id`, `include`, `exclude` and `versionFiles` are not allowed on a glob. A glob that matches no unit warns `W_UNIT_GLOB_UNMATCHED`.

```yaml
# tallyrelease.yaml
plugins:
  node: {}
units:
  "apps/*": { release: true } # api and web
  packages/db: { tags: [npm] }
branches:
  - { name: main, line: default }
```

## Released and build-only units

A unit is released when its overlay sets `release: true`, or when `defaults.release: true` is set and the unit does not opt out with `release: false`. A released unit gets versions, tags and changelogs. Its version source comes from the plugin (`file` for node, so `package.json` is updated) and can be changed with `version: file` or `version: tag`.

Every other unit is build-only: it is built when affected but never versioned. A change in a build-only unit is absorbed into the released units that depend on it, directly or through other build-only units. A `feat` or `fix` in `db` gives `api` a patch with the default `bumps.absorbed: patch`; with `bumps.absorbed: minor` a `feat` gives a minor. An absorbed change never gives a major. `explain` lists absorbed changes with `via db`.

## Edges and propagation

An edge `db -> api` says that `api` depends on `db`. Plugins create edges from manifests, and `deps` in the config adds more. An edge is pinned when the dependent's published manifest must change with the dependency's version, for example an exact version in `dependencies`. `api` depends on `@acme/db` with the range `*`, so its edge is not pinned.

When a released unit releases, its released dependents follow their `propagate` policy: `auto` (the default) gives a patch when the edge is pinned and only a rebuild otherwise, `patch` always gives a patch, `rebuild` never bumps. Propagation runs between released units only; changes of build-only units reach released units through absorption. If `db` were released, this config would release `api` with every `db` release:

```yaml
# tallyrelease.yaml
plugins:
  node: {}
units:
  apps/api: { release: true, propagate: patch }
  apps/web: { release: true }
  packages/db: { release: true }
branches:
  - { name: main, line: default }
```

## Groups

A fixed group is a set of released units that release together with one version. Members are selected by `units` (ids) or `tags` (released units with any of the tags). When one member has a pending release, every member releases at the group version. Tags and changelogs stay per unit, so a group `shop` of `api` and `web` still creates `api-v1.0.1` and `web-v1.0.1`. A group is a single release item: it is never split across release PRs, and `releasePr` is set on the group, not on its members.

```yaml
# tallyrelease.yaml
plugins:
  node: {}
units:
  apps/api: { release: true }
  apps/web: { release: true }
branches:
  - { name: main, line: default }
groups:
  shop: { units: [api, web], releasePr: shared }
```

## Lines and branch rules

`branches` is a list of branch rules. tallyrelease matches the current branch (or `--branch`) against them in order, and the first match wins. Patterns may use `*` (any characters, including `/`) and the captures `{major}` and `{minor}`. A rule has a `line`: `default` or `maintenance`. A maintenance rule with `{major}` caps bumps at minor, and one with `{minor}` caps them at patch. `release/{major}.x` is only a naming convention; the cap comes from the capture, so `support/{major}` behaves the same. A release that would exceed the cap fails with [`E_CAP`](errors.md#e_cap), which names the commits that caused it.

When no rule matches, the build set is still computed, but `plan` has no versions and warns `W_NO_BRANCH_RULE`, and `version`, `pr`, `release` and `run` do nothing (`W_EFFECT_SKIPPED`).

## Channels and prereleases

A line has prereleases only when its rule sets `channels`. `channels.build` labels the build prerelease of every push: `{next}-{build}.{N}`, for example `1.0.1-beta.2`, where `N` is the number of first-parent commits since the line base (the highest stable tag of the unit on HEAD's first-parent chain; without one, since the unit's introduction). A build prerelease is never tagged and nothing is written; the commit sha identifies the build. `channels.cut` labels cut prereleases: `pr` opens a prerelease PR, and merging it tags `{next}-{cut}.{K}` and creates a GitHub prerelease. `channel` is a deprecated alias of `channels.build`. See [releasing.md](releasing.md#prereleases).

```yaml
# tallyrelease.yaml
plugins:
  node: {}
units:
  apps/api: { release: true }
  apps/web: { release: true }
branches:
  - { name: main, line: default, channels: { build: beta, cut: rc } }
```

## Tags

A release is tagged with the unit's `tagFormat`: `{id}-v{version}` by default (`api-v1.0.1`), or `v{version}` for a unit at the repository root. The base tag of a unit is its highest stable tag reachable from HEAD; its version is the `from` of the next release. The line base, defined above, can differ from the base tag.

Floating tags are opt-in. With `tags.floating: ["{id}-v{major}"]`, each release also moves `api-v1` to the highest stable 1.x release of `api`. A format without `{id}`, such as `v{major}`, fits a repository with one released unit.

## Build base and build set

The build base is the commit tallyrelease diffs HEAD against. `--base` sets it. Without it, a local run uses the merge base with the default branch, and a run on GitHub Actions uses the event: the last successful run of the workflow on the branch (or the push's `before`) for pushes, the merge base with the target branch for pull requests.

The build set is every unit owning a file changed since the base, plus their dependents and the mates of affected group members. A change to a global input marks every unit affected: `tallyrelease.yaml`, the globs in `globalInputs` and the defaults of each plugin, such as lockfiles. For node the defaults are `yarn.lock`, `package-lock.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.yarnrc.yml`, `.yarn/patches/**`, `tsconfig*.json`, `turbo.json` and the root `package.json` when the repository has workspaces. `plugins.<name>.globalInputs: false` drops the defaults of a plugin. Global inputs never count towards a release. Files matching `ignore` globs are dropped from both the build set and release attribution.

## Plan and release list

`plan` computes a kind and versions for every unit in the build set (with `--all` also for released units with a pending release outside it): `from` (the base tag version), `bump`, `next` (the next stable version) and `version` (the build prerelease, if any). The kind is `prerelease` when the unit is in the build set, has a pending release and the line has a build channel, `rebuild` when it is in the build set otherwise, and `none` for a pending unit outside the build set (listed with `--all`). See [cli.md](cli.md#tallyrelease-plan) for the flags.

`run --github-output` writes the release list: every release, cut prerelease and build prerelease of the run, for your publishers. Its fields are described in [release-list.md](release-list.md).
