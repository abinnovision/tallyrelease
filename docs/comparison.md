# Comparison

As of release-please 17.11 and Changesets 3.0, October 2026.

|                               | tallyrelease                                                                                    | release-please                                             | Changesets                                                 |
| :---------------------------- | :---------------------------------------------------------------------------------------------- | :--------------------------------------------------------- | :--------------------------------------------------------- |
| Version source                | Conventional Commits, `Release-As` footer                                                       | Conventional Commits, `Release-As` footer                  | Hand-written `.changeset/*.md` intent files                |
| Ecosystems                    | `node`, `php`, `go`, `kustomize`, `dart`, `changesets`; config-only units (versioned from tags) | About 20 release types (node, java, python, rust, go, ...) | `package.json`-based packages                              |
| Monorepo dependency awareness | Plugin graph; per-unit propagation (`auto`, `patch`, `rebuild`)                                 | Paths only; workspace plugins patch internal dependents    | Workspace graph; `updateInternalDependencies`              |
| Affected build detection      | Yes (`affected`)                                                                                | No                                                         | No (left to turbo, Nx and similar)                         |
| Build-only units              | Yes; changes are absorbed into released dependents                                              | No                                                         | No                                                         |
| Version groups                | Fixed                                                                                           | Linked versions plugin                                     | Fixed and linked                                           |
| Prereleases                   | Per branch: builds `{next}-{build}.{N}`, cuts by prerelease PR                                  | `prerelease: true` with a prerelease versioning strategy   | `pre enter` / `pre exit` mode for all packages; snapshots  |
| Maintenance branches          | Branch rules cap bumps (`release/{major}.x`)                                                    | No bump caps                                               | No bump caps                                               |
| Release PRs                   | Shared or separate per item, plan rechecked on merge                                            | One PR or separate PRs, updated as commits land            | "Version Packages" PR via `changesets/action`              |
| Forge                         | GitHub for effects; `affected` in any CI with `--base`                                          | GitHub (Action or App)                                     | CLI forge-agnostic; PR automation on GitHub via the action |
| Publishing to registries      | No; hands a `releases` list to your publishers                                                  | No; gate publishing on action outputs                      | Yes, npm (`changeset publish`)                             |
| Preview/explain               | `plan`, `explain`, `--dry-run`                                                                  | CLI `--dry-run`; release PR content                        | `changeset status`, publish plan                           |

## vs. release-please

[release-please](https://github.com/googleapis/release-please) ([manifest releaser](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md), [customizing](https://github.com/googleapis/release-please/blob/main/docs/customizing.md), [action](https://github.com/googleapis/release-please-action)) is the closest relative.

### Shared

Both read Conventional Commits (`fix` patch, `feat` minor, `!` major) and honour `Release-As` footers. Both keep a release PR up to date as commits land and tag and create a GitHub release on merge. tallyrelease writes changelogs in the release-please format and uses the same tag shape (`{id}-v{version}`, `v{version}` for a root unit). The tags are compatible when each unit id equals the release-please component name. The default id is the last path segment of the unit root, or the repository name for a root unit; set `id` or `tagFormat` otherwise. With compatible tags, a repo can switch without retagging.

### Where tallyrelease differs

- Commits are matched to units by path, as in release-please, but releases also follow a dependency graph from plugins, with a propagation policy per unit.
- Build-only units are absorbed into released dependents; release-please has no equivalent.
- It computes the affected build set, so one tool drives CI builds and releases.
- Build prerelease numbers come from git history, so there is no committed prerelease state; cut prereleases are merged prerelease PRs that change only changelogs.
- Branch rules for maintenance lines cap bumps and report the commits that would break the line.
- The plan is recomputed on merge before tagging, and floating tags such as `v1` are moved when `tags.floating` is set.
- Before 1.0, a breaking change bumps minor by default (`bumps.preMajor.breaking: minor`); release-please bumps major unless `bump-minor-pre-major` is set.
- Configuration is a single `tallyrelease.yaml`; release-please uses `release-please-config.json` plus `.release-please-manifest.json`.

### Choose release-please if

You need one of its many release types (Java, Python, Rust, Go, Helm, Terraform and more), want a mature tool with a long track record, or need linked versions, which tallyrelease does not support.

## vs. Changesets

[Changesets](https://changesets.dev) ([repository](https://github.com/changesets/changesets), [action](https://github.com/changesets/action)) takes a different approach to release intent.

### Shared

Both handle monorepos with internal dependencies, support fixed version groups, open a release PR on GitHub and write changelogs per package.

### Where tallyrelease differs

- The commit message is the release intent, so there is no extra file per change. Changesets asks contributors to run `changeset add` and write a `.changeset/*.md` file, which teams often enforce with a bot or `changeset status`.
- Prereleases are per branch and need no mode switch. Changesets enters a repo-wide pre mode with `pre enter <tag>` and leaves it with `pre exit`; its docs note that "Prereleases are very complicated!".
- It works beyond `package.json` (PHP, Go, Kustomize, Dart, config-only units) and computes affected builds.
- It does not publish. It hands a `releases` list to your publishers, while `changeset publish` publishes to npm directly.

### Choose Changesets if

You publish npm packages and want publishing built in, need snapshot releases or linked groups, want curated, human-written release notes per change, or need versioning that does not depend on a particular forge.
