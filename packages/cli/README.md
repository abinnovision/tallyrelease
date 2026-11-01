# @tallyrelease/cli

tallyrelease computes the affected build units of a monorepo or single repo from git history and a dependency graph supplied by ecosystem plugins (`node`, `php`, `go`, `kustomize`, `dart` and `changesets` are built in, see the [plugin reference](https://github.com/abinnovision/tallyrelease/blob/main/docs/plugins.md#built-in-plugins)). It also plans releases and runs the release effects (version files, release PRs, tags, forge releases).

## Install

```sh
npm i -D @tallyrelease/cli
# or run without installing
npx @tallyrelease/cli affected
```

Requires Node >=24.

## Configuration

Create `tallyrelease.yaml` at the repository root:

```yaml
# yaml-language-server: $schema=./node_modules/@tallyrelease/cli/dist/tallyrelease.schema.json
plugins:
  node: {}
units:
  packages/api:
    release: true
```

Units are build-only unless opted in with `release: true` (per unit) or `defaults.release: true`.

Every key is listed in the [configuration reference](../../docs/configuration.md).

Tags label units so CI can split the build set by kind:

```yaml
units:
  apps/web: { tags: [docker] }
  packages/api: { release: true, tags: [npm] }
```

A key with `*` is a glob over unit roots: `*` is one path segment and skips dot directories (`apps/*` does not match `apps/web/sub`). Globs apply in declaration order, exact keys win field by field, and `id`, `include`, `exclude` and `versionFiles` are not allowed on a glob key. A glob never creates a unit and warns `W_UNIT_GLOB_UNMATCHED` when it matches nothing.

```yaml
units:
  "apps/*": { release: true, tags: [docker] } # * is one segment, skips dot dirs
  "packages/*": { release: true, tags: [npm] }
  packages/tsconfig: { release: false } # exact key wins field by field
```

## Commands

Global flags: `--cwd <dir>` (repository root), `--config <file>` (default `tallyrelease.yaml`), `--token <token>` (forge token, default `GITHUB_TOKEN`), `--remote <name>` (git remote to push to and read the repository from, default `origin`), `--verbose`, `--allow-local-plugins` (let `pr`, `release`, `run` and `version` load `plugins.<name>.path` plugins, also `TALLYRELEASE_ALLOW_LOCAL_PLUGINS=true`; never on a pull request head).

Errors print as `error[E_*]` and warnings as `warning[W_*]`. The [error and warning reference](../../docs/errors.md) lists the cause and fix of each code.

- `tallyrelease check` validates config, plugins, units, graph and release config; with released units it also checks the repository's tags. It then plans all units, which runs plugin `validate` hooks, so it needs git history like `plan`.
- `tallyrelease graph [--format text|json|mermaid] [--json]` prints units and edges.
- `tallyrelease affected [--base <ref>] [--format text|json|tsv] [--json] [--out <file>] [--github-output] [--tag <tag>]` computes the build set. `--out` writes the affected document as JSON, `--github-output` appends outputs to `$GITHUB_OUTPUT`. `--tag` (repeatable) keeps units with any of the given tags.
- `tallyrelease plan [--branch <name>] [--base <ref>] [--head <ref>] [--all] [--format text|json] [--json] [--out <file>] [--github-output] [--summary]` computes the release plan without changing anything: kind, base version, bump, next version and prerelease version per unit. `--head` plans another commit with the current config, `--all` also lists released units with a pending release outside the build set. `--github-output` writes `plan`, the path of the written plan (`--out`, else `$RUNNER_TEMP/tallyrelease-plan.json`). `--summary` appends a markdown summary to `$GITHUB_STEP_SUMMARY`, or prints it instead of the table when unset (exit 2 with `--json` then). The JSON schema (the plan is schema 1) is exported as `@tallyrelease/cli/plan.schema.json`.
- `tallyrelease explain <unit> [--branch <name>] [--base <ref>] [--format text|json] [--json]` explains a unit: why it is affected, which commits and files bump it (including changes absorbed from unreleased dependencies), propagation and Release-As footers. The JSON document (schema 1) is the explanation without the plan; its schema is exported as `@tallyrelease/cli/explain.schema.json`.

- `tallyrelease version [--branch <name>] [--dry-run]` writes version files and changelogs of all pending releases to the working tree.
- `tallyrelease pr [--branch <name>] [--dry-run]` opens or updates the release PRs (needs a token).
- `tallyrelease release [--branch <name>] [--dry-run]` tags merged release PRs, moves floating tags and creates forge releases (needs a token).
- `tallyrelease run [--branch <name>] [--base <ref>] [--dry-run] [--out <file>] [--github-output] [--summary]` is the CI entry point: `release`, then the plan, then `pr`. `--github-output` also writes `releases`.

Exit codes: `0` ok, `1` error, `2` usage. For scripts use `--format tsv` or `--json`; the text layout may change between versions.

## Build base

- Locally, `affected` diffs against the merge base with the default branch (`origin/HEAD`, else `main` or `master`).
- On GitHub Actions it uses the event and the forge; set `GITHUB_TOKEN` so it can look up the last successful run.
- On other CI everything is built unless `--base` is given.

## GitHub Actions

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0
  - run: npx @tallyrelease/cli affected --github-output
    env:
      GITHUB_TOKEN: ${{ github.token }}
```

The job needs `actions: read` for the base lookup. See [GitHub token](#github-token).

The `affected` output is a JSON array of `{id, path, plugin, reason, released, tags}` and works as a matrix:

```yaml
jobs:
  affected:
    runs-on: ubuntu-latest
    outputs:
      docker: ${{ steps.docker.outputs.affected }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: docker
        run: npx @tallyrelease/cli affected --tag docker --github-output
        env:
          GITHUB_TOKEN: ${{ github.token }}
  image:
    needs: affected
    if: needs.affected.outputs.docker != '[]'
    strategy:
      matrix:
        unit: ${{ fromJSON(needs.affected.outputs.docker) }}
    runs-on: ubuntu-latest
    steps:
      - run: echo "build ${{ matrix.unit.id }} from ${{ matrix.unit.path }}"
```

## Releases in CI

`tallyrelease run [--branch <name>] [--dry-run] [--base <ref>] [--out <file>] [--github-output] [--summary]` is the CI entry point: it reconciles merged release PRs (tags, GitHub releases, labels), plans HEAD, updates the release PRs and writes the plan. `release` and `pr` run the first and last step alone.

With `--github-output`, `run` writes two outputs to `$GITHUB_OUTPUT`:

- `plan`: the path of the plan document (`--out`, else `$RUNNER_TEMP/tallyrelease-plan.json`).
- `releases`: a compact JSON array of everything to publish. Stable releases come first, oldest release commit first, then in plan unit order. Prereleases follow in plan unit order, and a unit with a release at HEAD has none. Every stable tag in the range is listed, also several of one unit, so nothing tagged stays unpublished; a failed run lists its releases again on the next run.

| Field         | Meaning                                                                                                                                                                                                                                                                                                               |
| :------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `path`  | Unit id and root.                                                                                                                                                                                                                                                                                                     |
| `kind`        | `release` or `prerelease`.                                                                                                                                                                                                                                                                                            |
| `version`     | Released version, or the prerelease version of the plan.                                                                                                                                                                                                                                                              |
| `channel`     | Channel of the line for a prerelease, `null` for a release.                                                                                                                                                                                                                                                           |
| `tag`         | Version tag of a release, `null` for a prerelease.                                                                                                                                                                                                                                                                    |
| `releaseSha`  | Full sha of the tagged release commit, or HEAD for a prerelease.                                                                                                                                                                                                                                                      |
| `catchUp`     | `true` for a release not built from HEAD: its commit is not HEAD, or its unit is outside the build set (also at HEAD). Every `false` entry belongs to a unit in the build set.                                                                                                                                        |
| `forge`       | `{ pr, release }` looked up on the forge, `null` for a prerelease, without a forge or after a forge error in `plan`. `pr` is `{ number, url }` of the PR that merged the release commit, else `null`. `release` is `{ url }` of the forge release of the tag, else `null`, also for a release a dry run would create. |
| `latest`      | `true` for the unit's highest stable tag, never on a maintenance line, `false` for a prerelease.                                                                                                                                                                                                                      |
| `changes`     | Changes in the shape of the plan's `units[].changes`: the unit's own, then those of the units it was propagated from (transitively), each with `via` set to the owning unit; for a prerelease, those since the last stable release.                                                                                   |
| `tags`        | The unit's tags, sorted.                                                                                                                                                                                                                                                                                              |
| `group`       | Name of the unit's fixed group, else `null`.                                                                                                                                                                                                                                                                          |
| `line`        | Line of the planned branch, `default` or `maintenance`, for releases and prereleases.                                                                                                                                                                                                                                 |
| `buildNumber` | First-parent commit count of `releaseSha` plus the unit's `buildNumber.offset`, `null` for a unit without `buildNumber`. Not part of the version.                                                                                                                                                                     |

Within a major, entries only gain fields. The entry schema is `releaseEntrySchema` in `src/plan-schema.ts`.

### GitHub token

The token comes from `--token` or `GITHUB_TOKEN`. It authenticates two things: REST calls to the forge, and `git push` to `origin` or `--remote` (sent as an `Authorization` header that replaces persisted checkout credentials). Names below are fine-grained token and GitHub App permissions. `Metadata: read` is always granted.

#### Permissions per command

| Command             | Permissions                                                                                                | Without a token                                                                                                |
| :------------------ | :--------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------- |
| `affected`, `plan`  | `Actions: read` for the build base. `Pull requests: read` for the PR numbers in `plan` (`released` units). | Warns `W_NO_FORGE`. A push uses the event's `before` sha; `schedule` and `workflow_dispatch` build everything. |
| `pr --dry-run`      | `Contents: read`, `Pull requests: read`, `Issues: read`                                                    | `E_NO_FORGE`                                                                                                   |
| `pr`                | `Contents: write`, `Pull requests: write`, `Issues: write`                                                 | `E_NO_FORGE`                                                                                                   |
| `release --dry-run` | `Contents: read`, `Pull requests: read`, `Issues: read`                                                    | `E_NO_FORGE`                                                                                                   |
| `release`           | `Contents: write`, `Pull requests: write`, `Issues: write`                                                 | `E_NO_FORGE`                                                                                                   |
| `run --dry-run`     | read set below                                                                                             | `E_NO_FORGE`                                                                                                   |
| `run`               | write set below                                                                                            | `E_NO_FORGE`                                                                                                   |

`run` also needs `Actions: read` for the build base. When the forge fails while looking it up, `run` stops with `E_BASE_REQUIRED` before changing anything.

Calls behind these permissions:

| Permission             | Calls                                                                                                                                                                                      |
| :--------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Actions: read`        | `GET /actions/workflows/{workflow}/runs` (last successful push run)                                                                                                                        |
| `Contents: read`       | `GET /git/ref/heads/{branch}` (branch tips), `GET /releases/tags/{tag}`                                                                                                                    |
| `Contents: write`      | `git push` of release PR branches and tags, `POST /releases`                                                                                                                               |
| `Pull requests: read`  | `GET /pulls`, `GET /pulls/{n}`, `GET /commits/{sha}/pulls`                                                                                                                                 |
| `Pull requests: write` | `POST /pulls`, `PATCH /pulls/{n}` (update, close)                                                                                                                                          |
| `Issues: read`         | `GET /issues?labels=tallyrelease: pending` (finds release PRs; this endpoint has no pull request alternative)                                                                              |
| `Issues: write`        | Labels and comments on release PRs: `GET /labels/{name}`, `POST /labels`, `GET`/`POST`/`DELETE /issues/{n}/labels`, `POST /issues/{n}/comments`. `Pull requests: write` also covers these. |

Labels `tallyrelease: pending`, `tallyrelease: released` and `tallyrelease: stale` are created on first use. Create them up front to run without label creation rights.

#### Minimal sets

| Use                            | Permissions                                                                 |
| :----------------------------- | :-------------------------------------------------------------------------- |
| Read-only (`affected`, `plan`) | `Actions: read`, `Pull requests: read`                                      |
| Dry run (`run --dry-run`)      | `Actions: read`, `Contents: read`, `Pull requests: read`, `Issues: read`    |
| Full release (`run`)           | `Actions: read`, `Contents: write`, `Pull requests: write`, `Issues: write` |

In a workflow:

```yaml
permissions:
  actions: read
  contents: write
  pull-requests: write
  issues: write
```

#### Token types

| Token                         | Notes                                                                                                                                                                                                                                                  |
| :---------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`                | Simplest. Pushes and PRs made with it trigger no workflows: release PRs get no CI, and the tag push starts nothing. Set `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` to `github-actions[bot]` and `41898282+github-actions[bot]@users.noreply.github.com`. |
| GitHub App installation token | Recommended. Pushes trigger workflows. Grant the permissions above and set the commit identity with `GIT_AUTHOR_*` (and `GIT_COMMITTER_*`) to the App's bot name and email.                                                                            |
| Fine-grained PAT              | Same permissions, limited to the repository. Pushes trigger workflows. Tied to a user and expires.                                                                                                                                                     |
| Classic PAT                   | Scope `repo`. Add `workflow` only when version files live under `.github/workflows`.                                                                                                                                                                   |

Release commits use `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` and `GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL` (the committer defaults to the author). Without them the identity is `tallyrelease <tallyrelease@users.noreply.github.com>`. Release commits are not signed.

#### Repository rules

- The token must push and force-push `tallyrelease/release/<branch>/<item>` branches. The push uses `--force-with-lease`, and deletes branches of closed release PRs.
- It must create tags matching the unit tag formats, and move floating tags (a forced push).
- Rulesets that restrict tag creation or update, or branches matching `tallyrelease/**`, need a bypass for the App or user.
- Rulesets that require signed commits or linear history on `tallyrelease/release/**` reject release commits; exempt those branches or give the App a bypass.
- Required status checks on the default branch need CI on the release PR. Use an App or PAT token, since `GITHUB_TOKEN` does not trigger it.
- `Workflows` permission is not needed unless version files live under `.github/workflows`.

## Shadow mode

To compare with release-please, pin `@tallyrelease/cli` 0.4.x and run `shadow` from it.

## Editor support

`tallyrelease.yaml` has a JSON schema for completion and validation in editors using the YAML language server. Add one of these modelines as the first line.

```yaml
# yaml-language-server: $schema=./node_modules/@tallyrelease/cli/dist/tallyrelease.schema.json
# yaml-language-server: $schema=https://cdn.jsdelivr.net/npm/@tallyrelease/cli@0/dist/tallyrelease.schema.json
```

Use the `node_modules` path when the cli is installed. Use the CDN URL when there is no Node setup; `@0` tracks the latest 0.x release, so pin a version for stability.

## Design

See the [design document](https://github.com/abinnovision/tallyrelease/blob/main/docs/design.md).

## Licence

Apache-2.0
