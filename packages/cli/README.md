# @tallyrelease/cli

tallyrelease computes the affected build units of a monorepo or single repo from git history and a dependency graph supplied by ecosystem plugins (`node`, `php`, `go`, `kustomize`, `dart` and `changesets` are built in). It plans versions from Conventional Commits and runs the release effects on GitHub: version files, release PRs, tags and GitHub releases.

## Install

```sh
npm i -D @tallyrelease/cli
# or run without installing
npx @tallyrelease/cli check
```

Requires Node >=24.

## Configure

Create `tallyrelease.yaml` at the repository root:

```yaml
# yaml-language-server: $schema=./node_modules/@tallyrelease/cli/dist/tallyrelease.schema.json
plugins:
  node: {}
units:
  apps/api: { release: true }
  apps/web: { release: true }
branches:
  - { name: main, line: default }
```

## Use

- `tallyrelease check` validates the config, the units, the graph and the release config.
- `tallyrelease affected` lists the units the current change affects, including dependents.
- `tallyrelease plan` shows the release plan: kind, current version, bump and next version per unit.

`tallyrelease run` is the CI entry point: it tags merged release PRs, creates GitHub releases and opens or updates the release PRs.

## Documentation

- [Getting started](https://github.com/abinnovision/tallyrelease/blob/main/docs/getting-started.md)
- [CI](https://github.com/abinnovision/tallyrelease/blob/main/docs/ci.md)
- [CLI reference](https://github.com/abinnovision/tallyrelease/blob/main/docs/cli.md)
- [Configuration reference](https://github.com/abinnovision/tallyrelease/blob/main/docs/configuration.md)
- [Errors and warnings](https://github.com/abinnovision/tallyrelease/blob/main/docs/errors.md)
- [All documentation](https://github.com/abinnovision/tallyrelease/blob/main/docs/README.md)

## Licence

Apache-2.0
