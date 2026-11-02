# tallyrelease documentation

tallyrelease computes the affected build units and the release plan of a monorepo or single repo from git history and Conventional Commits.

## Start

- [Getting started](getting-started.md): install, configure and run the first commands.

## Understand

- [Concepts](concepts.md): units, edges, groups, lines, channels, the build base and the plan.
- [Releasing](releasing.md): the release PR cycle, versions from commits, maintenance lines and prereleases.
- [Recipes](recipes.md): step-by-step guides for common setups.

## Operate

- [CI](ci.md): GitHub Actions setup, outputs, token permissions and recovery.
- [Plugin authoring guide](plugins.md): write a plugin for another ecosystem.
- [node](plugins/node.md): npm, Yarn and pnpm packages.
- [php](plugins/php.md): Composer projects.
- [go](plugins/go.md): Go modules.
- [kustomize](plugins/kustomize.md): kustomization directories.
- [dart](plugins/dart.md): Dart and Flutter packages.
- [changesets](plugins/changesets.md): `.changeset/*.md` files as an intent source.
- [config-only](plugins/config-only.md): units without a plugin or manifest.

## Reference

- [CLI](cli.md): every command and flag.
- [Configuration](configuration.md): every key of `tallyrelease.yaml`.
- [Release list](release-list.md): fields of the `releases` output.
- [Errors and warnings](errors.md): cause and fix of every code.

## Project

- [Comparison](comparison.md): tallyrelease next to release-please and Changesets.
- [Design](design.md): the internal specification.

`cli.md`, `configuration.md`, `release-list.md` and `errors.md` are generated from the code with `yarn fix`, as are the git history drawings in `assets/` from `assets/histories/*.json`.
