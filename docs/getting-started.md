# Getting started

## Install

```sh
npm i -D @tallyrelease/cli
# or run without installing
npx @tallyrelease/cli affected
```

tallyrelease needs Node 24 or later.

## Configure

Create `tallyrelease.yaml` at the repository root. The examples on this page use an npm workspaces monorepo with two apps and one shared package:

- `apps/api` is the unit `api`. It is released and depends on `@acme/db`.
- `apps/web` is the unit `web`. It is released and has no internal dependencies.
- `packages/db` is the unit `db`. It is build-only.

```yaml
# tallyrelease.yaml
plugins:
  node: {}
units:
  apps/api: { release: true }
  apps/web: { release: true }
branches:
  - { name: main, line: default }
```

Plugins discover the units and their dependency edges. The `node` plugin finds every workspace package. The built-in plugins are `node`, `php`, `go`, `kustomize`, `dart` and `changesets`, see the [plugin authoring guide](plugins.md).

Units are build-only unless they opt in with `release: true` (per unit) or `defaults.release: true`. A change to `db` reaches `api` through the edge `db -> api`.

The `branches` rule is required for versions. Without a matching rule, `plan` warns `W_NO_BRANCH_RULE` and shows no versions, and `pr`, `release`, `run` and `version` skip with `W_EFFECT_SKIPPED`.

tallyrelease reads the current version of a released unit from its highest stable tag. In a repository whose history predates tallyrelease, tag the current version of each released unit once (`git tag api-v1.0.0 <sha>`), otherwise the first release starts at `initialVersion` (1.0.0 for semver) and the changelog covers the whole history. The example repository has `api-v1.0.0` and `web-v1.0.0` on `main`.

Unit `tags` in the config (unrelated to git tags) label units so CI can split the build set by kind:

```yaml
# tallyrelease.yaml
plugins:
  node: {}
units:
  apps/web: { release: true, tags: [docker] }
  apps/api: { release: true, tags: [npm] }
branches:
  - { name: main, line: default }
```

A key with `*` is a glob over unit roots, see [concepts.md](concepts.md#units) for the matching rules.

```yaml
# tallyrelease.yaml
plugins:
  node: {}
units:
  "apps/*": { release: true, tags: [docker] } # * is one segment, skips dot dirs
  "packages/*": { release: true, tags: [npm] }
  packages/db: { release: false } # exact key wins field by field
branches:
  - { name: main, line: default }
```

Every key is listed in the [configuration reference](configuration.md).

## Check the setup

```sh
tallyrelease check
```

```text
ok: 3 units (2 released: api, web), 1 edge
```

`check` validates the config, the plugins, the units, the graph, the release config and the tags. It also plans all units, so it needs git history like `plan`.

## See what a change affects

On the branch `feature/orders`, `affected` lists the build set:

```sh
tallyrelease affected
```

```text
base  547e10f (merge base with main)

direct (2)
  db   packages/db
  web  apps/web             released
dependent (1)
  api  apps/api     via db  released

3 of 3 units affected
```

Outside CI the base is the merge base with the default branch: `origin/HEAD`, else `main` or `master`. `--base <ref>` picks another base. The `db` and `web` units changed directly, and `api` is affected through `db`. See [CI](ci.md#build-base) for the base in CI.

For scripts, `--format tsv` prints one row per unit with a header:

```sh
tallyrelease affected --format tsv
```

```text
id	path	reason	via	released	tags
api	apps/api	dependent	db	true
db	packages/db	direct		false
web	apps/web	direct		true
```

`--tag <tag>` (repeatable) keeps only units that carry one of the tags.

`graph` prints the units and the dependents of each:

```sh
tallyrelease graph
```

```text
UNIT  PATH         PLUGIN  RELEASE
api   apps/api     node    file
db    packages/db  node    -
web   apps/web     node    file

dependents
db
└── api
web

3 units (2 released), 1 edge
```

`graph --format mermaid` prints a Mermaid flowchart instead.

## See what would release

`plan` adds versions to the build set. The `feature/orders` branch has no branch rule, so pass `--branch main` to plan for the target branch:

```sh
tallyrelease plan --branch main
```

```text
branch  main (rule main, default line)
base    547e10f (merge base with main)

UNIT  KIND     FROM   BUMP   NEXT   VERSION
db    rebuild  -      -      -      -
api   rebuild  1.0.0  patch  1.0.1  -
web   rebuild  1.0.0  patch  1.0.1  -

3 units planned: 3 rebuild
```

- `KIND` is `rebuild` for a unit in the build set, `prerelease` when a build channel gives it a prerelease version, and `none` for a released unit with a pending release outside the build set (listed with `--all`).
- `FROM` is the version of the unit's base tag, `-` for a build-only unit or a released unit without a base tag.
- `BUMP` is the level the Conventional Commits since the base tag require.
- `NEXT` is the version the next release will have.
- `VERSION` is the version a build of this commit gets. It is `-` unless a build channel makes it a prerelease version.

`explain` shows why one unit is in the plan:

```sh
tallyrelease explain api --branch main
```

```text
api  apps/api  node  semver
base    547e10f (merge base with main)

affected  dependent via db
release   1.0.0 -> 1.0.1 (patch)
  base tag api-v1.0.0

changes (1)
  acdcd7d  feat  add order lookup  via db
      packages/db/src/index.js
```

The commit touches `packages/db`, which `api` depends on. A `feat` in a build-only dependency is absorbed into `api` as a patch change by default.

`pr --dry-run` prints the release PRs it would create, update or close, without pushing anything. `pr` needs a forge token. Without one it fails with `E_NO_FORGE`:

```sh
tallyrelease pr --dry-run --branch main
```

```text
error[E_NO_FORGE]: pr needs a forge token; pass --token or set GITHUB_TOKEN
```

## Editor support

`tallyrelease.yaml` has a JSON schema for completion and validation in editors that use the YAML language server. Add one of these modelines as the first line.

```yaml
# yaml-language-server: $schema=./node_modules/@tallyrelease/cli/dist/tallyrelease.schema.json
# yaml-language-server: $schema=https://cdn.jsdelivr.net/npm/@tallyrelease/cli@0/dist/tallyrelease.schema.json
```

Use the `node_modules` path when the cli is installed. Use the CDN URL when there is no Node setup. `@0` tracks the latest 0.x release, so pin a version for stability.

## Next

- [Releasing](releasing.md): how releases and branches work.
- [CI](ci.md): run the commands in GitHub Actions.
- [CLI](cli.md): every command and flag.
