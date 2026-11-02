# CI with GitHub Actions

Release effects need GitHub. `affected` works on any CI when you pass `--base`.

## Checkout and history

Check out the full history in `actions/checkout` with `fetch-depth: 0`, optionally with `filter: blob:none`.

A shallow clone fails only when it lacks what a command needs:

- `E_SHALLOW_BASE` when the base commit is missing from the clone, or has no common history with HEAD in it.
- `E_BUILD_NUMBER_SHALLOW` when a unit has `buildNumber`, since the build number counts first-parent commits. `run --github-output` raises it before any effect.

## Build base

The build base is the commit `affected` and `plan` diff against.

- Locally, it is the merge base with the default branch (`origin/HEAD`, else `main` or `master`).
- On GitHub Actions it comes from the event and the forge. A pull request uses the merge base with the target branch, and a merge group uses its base sha. A push uses the last successful run of the workflow on the branch when it is an ancestor of the event's `before` sha, else `before`. The forge lookup needs `GITHUB_TOKEN` with `actions: read`.
- On other CI everything is built unless `--base` is given.

## Affected builds

Pin an exact version in workflows (`npx @tallyrelease/cli@<version>`), or install the cli as a devDependency and run `npx tallyrelease`. The snippets use the unpinned form for brevity.

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0
  - run: npx @tallyrelease/cli affected --github-output
    env:
      GITHUB_TOKEN: ${{ github.token }}
```

The `affected` output is a JSON array, so it works as a matrix. `--tag` keeps the units that carry the tag, here `docker`:

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

`affected --github-output` writes these outputs to `$GITHUB_OUTPUT`:

| Output           | Value                                                                                      |
| :--------------- | :----------------------------------------------------------------------------------------- |
| `affected`       | Compact JSON array of `{id, path, plugin, reason, released, tags}`, ordered by unit id.    |
| `affected-paths` | Newline list of the unit paths.                                                            |
| `all`            | `true` when the base is null or a global input changed, so everything is in the build set. |
| `base`           | The resolved base sha, empty when there is none.                                           |
| `base-source`    | Where the base came from.                                                                  |

## Releases

`tallyrelease run` is the single entry point for releases. In order, it:

1. Reconciles merged release PRs: it tags them, creates the GitHub releases and labels the PRs.
2. Plans HEAD.
3. Opens or updates the release PRs.
4. Writes the plan.

`release` and `pr` run the first and the third step alone.

```yaml
name: release
on:
  push:
    branches: [main]
permissions:
  actions: read
  contents: write
  pull-requests: write
  issues: write
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false
jobs:
  release:
    runs-on: ubuntu-latest
    outputs:
      releases: ${{ steps.run.outputs.releases }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: run
        run: npx @tallyrelease/cli run --github-output --summary
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GIT_AUTHOR_NAME: github-actions[bot]
          GIT_AUTHOR_EMAIL: 41898282+github-actions[bot]@users.noreply.github.com
  publish:
    needs: release
    if: needs.release.outputs.releases != '[]'
    strategy:
      matrix:
        release: ${{ fromJSON(needs.release.outputs.releases) }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ matrix.release.releaseSha }}
      - run: echo "publish ${{ matrix.release.id }} ${{ matrix.release.version }}"
```

The `concurrency` group keeps one run per branch. Leave `cancel-in-progress` off, because cancelling a run in the middle of tagging leaves work for the next run.

`run --github-output` writes two outputs:

| Output     | Value                                                                                                         |
| :--------- | :------------------------------------------------------------------------------------------------------------ |
| `plan`     | Path of the plan JSON: `--out`, else `$RUNNER_TEMP/tallyrelease-plan.json`.                                   |
| `releases` | Compact JSON array of everything to publish. The fields are in the [release list reference](release-list.md). |

`--summary` appends a markdown summary of the plan to `$GITHUB_STEP_SUMMARY`.

Tags and PRs created with `GITHUB_TOKEN` trigger no workflows. Publishing therefore runs in the same workflow, from `releases`, instead of in a workflow that listens for tags. Entries with `catchUp: true` are not built from HEAD, so check them out and build them from their `releaseSha`, as the `publish` job does.

## Token

The token comes from `--token` or `GITHUB_TOKEN`. It authenticates two things: REST calls to the forge, and `git push` to `origin` or `--remote` (sent as an `Authorization` header that replaces persisted checkout credentials). Names below are fine-grained token and GitHub App permissions. `Metadata: read` is always granted.

### Permissions per command

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

### Minimal sets

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

### Token types

| Token                         | Notes                                                                                                                                                                                                                                                  |
| :---------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`                | Simplest. Pushes and PRs made with it trigger no workflows: release PRs get no CI, and the tag push starts nothing. Set `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` to `github-actions[bot]` and `41898282+github-actions[bot]@users.noreply.github.com`. |
| GitHub App installation token | Recommended. Pushes trigger workflows. Grant the permissions above and set the commit identity with `GIT_AUTHOR_*` (and `GIT_COMMITTER_*`) to the App's bot name and email.                                                                            |
| Fine-grained PAT              | Same permissions, limited to the repository. Pushes trigger workflows. Tied to a user and expires.                                                                                                                                                     |
| Classic PAT                   | Scope `repo`. Add `workflow` only when version files live under `.github/workflows`.                                                                                                                                                                   |

Release commits use `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` and `GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL` (the committer defaults to the author). Without them the identity is `tallyrelease <tallyrelease@users.noreply.github.com>`. Release commits are not signed.

## Repository rules

- The token must push and force-push `tallyrelease/release/<branch>/<item>` and `tallyrelease/prerelease/<branch>/<item>` branches. The push uses `--force-with-lease`, and deletes branches of closed release PRs.
- It must create tags matching the unit tag formats, and move floating tags (a forced push).
- Rulesets that restrict tag creation or update, or branches matching `tallyrelease/**`, need a bypass for the App or user.
- Rulesets that require signed commits or linear history on `tallyrelease/release/**` and `tallyrelease/prerelease/**` reject release commits. Exempt those branches or give the App a bypass.
- With required status checks on the default branch, use an App or PAT token so the release PR gets CI.

## Re-runs and recovery

- `E_BASE_REQUIRED`: the forge failed while `run` resolved the base. Re-run when the forge is healthy and check `actions: read`. Do not bypass it with an empty base, since that would move the last successful run past unpublished releases.
- A failed publish is listed again on the next run, because the base falls back to the last successful run. Publishers must therefore treat an already published version as success. `latest` is computed when the run happens, so re-running old failed jobs can publish an older release with `latest: true`. Prefer letting the next run list the release again.
- `E_PENDING_RECONCILE`: a merged release PR is not tagged yet. Run `release` or `run` first.
- `E_TAG_EXISTS`: a version tag points at another commit. Inspect both, delete the wrong tag or label the PR `tallyrelease: stale`, then re-run.
- `E_PUSH_LEASE`: another writer moved the release branch. Re-run.
- `W_PR_HEAD_BEHIND`: HEAD is not the tip of the branch, so a re-run of an old run changes no PR.
- Never remove `tallyrelease: pending` from a merged PR. If that happened, add it again and re-run.

Every code is listed with its cause and fix in the [error reference](errors.md).
