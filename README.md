<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo-light.svg" alt="tallyrelease" width="360">
  </picture>
</p>

<p align="center">Affected builds and release plans for monorepos, from one dependency graph.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tallyrelease/cli"><img src="https://img.shields.io/npm/v/@tallyrelease/cli" alt="npm version"></a>
  <a href="https://github.com/abinnovision/tallyrelease/actions/workflows/ci.yaml"><img src="https://img.shields.io/github/actions/workflow/status/abinnovision/tallyrelease/ci.yaml?branch=main&label=CI" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@tallyrelease/cli" alt="Node >=24"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> · <a href="#comparison">Comparison</a> · <a href="packages/cli/README.md">Docs</a>
</p>

tallyrelease reads git history, Conventional Commits and a dependency graph supplied by ecosystem plugins. From that it decides which units of a repository a change affects, which units release and at what version. It then runs the release effects: version files, changelogs, release PRs, tags and forge releases. It works for monorepos and single repos.

> [!WARNING]
> tallyrelease is in beta. Until 1.0, any `0.x` minor release may contain breaking changes to config, CLI flags and outputs. Pin an exact version and read the [changelog](packages/cli/CHANGELOG.md) before upgrading.

## Why tallyrelease

- **One graph for builds and releases.** The same units and edges decide what CI builds and what gets a new version, so both come from one model of the repo.
- **Build-only units.** Units are built but not released unless you opt them in. A change in an unreleased internal package is absorbed into the released units that depend on it (as a patch by default), so internal libraries need no version of their own.
- **Prereleases without committed state.** Prerelease versions are `{next}-{channel}.{N}`, where `N` counts first-parent commits since the last stable release on the line. Nothing is written to the repo and no registry is queried.
- **Maintenance lines.** Branch rules such as `release/{major}.x` cap bumps at minor (and `release/{major}.{minor}.x` at patch), and fail with the offending commits when a change would leave the line.
- **See before you write.** `plan`, `explain` and `--dry-run` show versions, bumps and the commits behind them before anything changes. The planning core does no I/O and is deterministic for a given repository state.
- **Ecosystem plugins.** `node`, `php`, `kustomize` and `dart` are built in. Anything else can be declared as a config-only unit that versions through git tags, or added with your own plugin (see the [plugin authoring guide](docs/plugins.md)).

## How it works

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/how-it-works-dark.svg">
    <img src="docs/assets/how-it-works-light.svg" alt="How tallyrelease works">
  </picture>
</p>

Plugins discover units and the edges between them. tallyrelease attributes each commit to units by path, walks the graph to find dependents, and turns the result into a build set and a release plan per branch line. The cli applies the plan as effects on GitHub, and your existing pipelines build and publish what it lists.

## Quick start

Install the cli:

```sh
npm i -D @tallyrelease/cli
# or run without installing
npx @tallyrelease/cli affected
```

Create `tallyrelease.yaml` at the repository root:

```yaml
# yaml-language-server: $schema=./node_modules/@tallyrelease/cli/dist/tallyrelease.schema.json
plugins:
  node: {}
units:
  packages/api:
    release: true
```

Validate the config, units and graph:

```sh
tallyrelease check
```

See what the current branch affects:

```text
$ tallyrelease affected
base  4f2a91c (merge base with origin/main)

direct (1)
  db          packages/db
dependent (3)
  api-server  apps/api-server  via db          released
  scripts     scripts          via api-server
  tests       tests            via api-server

4 of 10 units affected, 2 files outside any unit
```

Preview the release plan without changing anything:

```sh
tallyrelease plan
```

In GitHub Actions, `tallyrelease run` is the single entry point: it tags merged release PRs, creates GitHub releases, plans HEAD and opens or updates the release PRs. Check out with `fetch-depth: 0`. See [packages/cli/README.md](packages/cli/README.md) for workflows, outputs and token permissions.

## Commands

| Command    | What it does                                                                 |
| :--------- | :--------------------------------------------------------------------------- |
| `affected` | Computes the build set: changed units and their dependents.                  |
| `graph`    | Prints units and edges as text, JSON or Mermaid.                             |
| `check`    | Validates config, plugins, units, graph, release config and tags.            |
| `plan`     | Computes the release plan (bump, next version, prerelease) without writing.  |
| `explain`  | Shows why a unit is affected and which commits bump it.                      |
| `shadow`   | Compares tallyrelease with a release-please release, for a gated migration.  |
| `version`  | Writes version files and changelogs of pending releases to the working tree. |
| `pr`       | Opens or updates the release PRs.                                            |
| `release`  | Tags merged release PRs, moves floating tags and creates forge releases.     |
| `run`      | CI entry point: `release`, then the plan, then `pr`.                         |

## Usage

Outside CI, `affected` diffs against the merge base with the default branch (`origin/HEAD`, else `main` or `master`), so it shows what the current branch changed. On GitHub Actions it uses the event and the forge; other CI builds everything unless `--base` is given. For scripts, use `--format tsv` or `--json`; the text layout may change between versions.

````sh
tallyrelease affected --format tsv
tallyrelease graph --format mermaid
{ echo '```mermaid'; tallyrelease graph --format mermaid; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
````

Units are build-only unless opted in with `release: true` (per unit) or `defaults.release: true`; plugins supply the version source (`file` or `tag`).

## Editor support

`tallyrelease.yaml` has a JSON schema for completion and validation in editors using the YAML language server. Add one of these modelines as the first line.

```yaml
# yaml-language-server: $schema=./node_modules/@tallyrelease/cli/dist/tallyrelease.schema.json
# yaml-language-server: $schema=https://cdn.jsdelivr.net/npm/@tallyrelease/cli@0/dist/tallyrelease.schema.json
```

Use the `node_modules` path when the cli is installed, since it always matches the installed version. Use the CDN URL when there is no Node setup; `@0` tracks the latest 0.x release, so pin a version for stability.

## Comparison

As of release-please 17.11 and Changesets 3.0, October 2026. Corrections welcome.

|                               | tallyrelease                                                    | release-please                                             | Changesets                                                 |
| :---------------------------- | :-------------------------------------------------------------- | :--------------------------------------------------------- | :--------------------------------------------------------- |
| Version source                | Conventional Commits, `Release-As` footer                       | Conventional Commits, `Release-As` footer                  | Hand-written `.changeset/*.md` intent files                |
| Ecosystems                    | `node`, `php`, `kustomize`, `dart`; config-only units via tags  | About 20 release types (node, java, python, rust, go, ...) | `package.json`-based packages                              |
| Monorepo dependency awareness | Plugin graph; per-unit propagation (`auto`, `patch`, `rebuild`) | Paths only; workspace plugins patch internal dependents    | Workspace graph; `updateInternalDependencies`              |
| Affected build detection      | Yes (`affected`)                                                | No                                                         | No (left to turbo, Nx and similar)                         |
| Build-only units              | Yes; changes are absorbed into released dependents              | No                                                         | No                                                         |
| Version groups                | Fixed                                                           | Linked versions plugin                                     | Fixed and linked                                           |
| Prereleases                   | Per branch channel, `{next}-{channel}.{N}`, no committed state  | `prerelease: true` with a prerelease versioning strategy   | `pre enter` / `pre exit` mode for all packages; snapshots  |
| Maintenance branches          | Branch rules cap bumps (`release/{major}.x`)                    | No bump caps                                               | No bump caps                                               |
| Release PRs                   | Shared or separate per item, plan rechecked on merge            | One PR or separate PRs, updated as commits land            | "Version Packages" PR via `changesets/action`              |
| Forge                         | GitHub for effects; `affected` in any CI with `--base`          | GitHub (Action or App)                                     | CLI forge-agnostic; PR automation on GitHub via the action |
| Publishing to registries      | No; hands a `releases` list to your publishers                  | No; gate publishing on action outputs                      | Yes, npm (`changeset publish`)                             |
| Preview/explain               | `plan`, `explain`, `--dry-run`                                  | CLI `--dry-run`; release PR content                        | `changeset status`, publish plan                           |

### vs. release-please

[release-please](https://github.com/googleapis/release-please) ([manifest releaser](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md), [customizing](https://github.com/googleapis/release-please/blob/main/docs/customizing.md), [action](https://github.com/googleapis/release-please-action)) is the closest relative.

**Shared.** Both read Conventional Commits (`fix` patch, `feat` minor, `!` major) and honour `Release-As` footers. Both keep a release PR up to date as commits land and tag and create a GitHub release on merge. tallyrelease writes changelogs in the release-please format and uses compatible tag names (`{id}-v{version}`, `v{version}` for a root unit), so a repo can switch without retagging.

**Where tallyrelease differs.**

- Commits are matched to units by path, as in release-please, but releases also follow a dependency graph from plugins, with a propagation policy per unit.
- Build-only units are absorbed into released dependents; release-please has no equivalent.
- It computes the affected build set, so one tool drives CI builds and releases.
- Prerelease numbers come from git history, so there is no committed prerelease state.
- Branch rules for maintenance lines cap bumps and report the commits that would break the line.
- The plan is recomputed on merge before tagging, and floating tags (such as `v1`) are moved for you.
- Before 1.0, a breaking change bumps minor by default (`preMajor.breaking: minor`); release-please bumps major unless `bump-minor-pre-major` is set.
- Configuration is a single `tallyrelease.yaml`; release-please uses `release-please-config.json` plus `.release-please-manifest.json`.
- `shadow` runs next to release-please and reports where the two would release different versions, so a migration can be gated on evidence.

**Choose release-please if** you need one of its many release types (Java, Python, Rust, Go, Helm, Terraform and more), want a mature tool with a long track record, or need linked versions, which tallyrelease does not support yet.

### vs. Changesets

[Changesets](https://changesets.dev) ([repository](https://github.com/changesets/changesets), [action](https://github.com/changesets/action)) takes a different approach to release intent.

**Shared.** Both handle monorepos with internal dependencies, support fixed version groups, open a release PR on GitHub and write changelogs per package.

**Where tallyrelease differs.**

- The commit message is the release intent, so there is no extra file per change. Changesets asks contributors to run `changeset add` and write a `.changeset/*.md` file, which teams often enforce with a bot or `changeset status`.
- Prereleases are per branch and need no mode switch. Changesets enters a repo-wide pre mode with `pre enter <tag>` and leaves it with `pre exit`; its docs note that "Prereleases are very complicated!".
- It works beyond `package.json` (PHP, Kustomize, config-only units) and computes affected builds.
- It does not publish. It hands a `releases` list to your publishers, while `changeset publish` publishes to npm directly.

**Choose Changesets if** you publish npm packages and want publishing built in, need snapshot releases or linked groups, want curated, human-written release notes per change, or need versioning that does not depend on a particular forge.

tallyrelease does not replace turbo, Nx or moon. It answers "what changed and what releases"; task runners still run the builds, and the two can be used together.

Planned: a `changesets` intent source and `tallyrelease import release-please` (see "Later" in [docs/design.md](docs/design.md)).

## Status

tallyrelease is in beta (0.3, pre-1.0). Release effects (PRs, tags, releases) target GitHub only. It requires Node 24 or later and full git history (no shallow clones). While on `0.x`, any minor release may break config, CLI flags and outputs, so pin an exact version. This repository releases itself with tallyrelease, with `@tallyrelease/core` and `@tallyrelease/cli` as one fixed group. See [docs/design.md](docs/design.md) for the design, milestones and decisions.

## Packages

| Package              | Purpose                                 |
| :------------------- | :-------------------------------------- |
| `@tallyrelease/core` | Pure planning core and plugin contract. |
| `@tallyrelease/cli`  | The `tallyrelease` binary.              |

## Development

Requires Node 24 and Yarn (via corepack).

```bash
make setup-dev
yarn check
yarn build
yarn test-unit
yarn turbo test-integration
```

## Acknowledgements

tallyrelease builds on ideas from existing release tools. [release-please](https://github.com/googleapis/release-please) shaped the release PR flow, the changelog format and the tag names, and [Changesets](https://changesets.dev) informed how release intent and groups work. Affected builds borrow from task runners such as [turbo](https://turborepo.com), [Nx](https://nx.dev) and [moon](https://moonrepo.dev). See [Comparison](#comparison) for how they differ.

tallyrelease was designed and written with help from AI coding assistants. The maintainers review the design, code and tests and are responsible for them.

## Licence

Apache-2.0, see [LICENSE](LICENSE).
