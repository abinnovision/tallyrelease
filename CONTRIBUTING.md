# Contributing

Thanks for helping with tallyrelease. Bug reports, plugin requests and pull requests are welcome.

## Setup

You need Node >=24 (see `.tool-versions`) and Yarn 4 through Corepack.

```bash
make setup-dev        # dependency check and install
make setup-worktree   # same, for a linked git worktree
```

## Commands

```bash
yarn build                    # build all packages
yarn fix                      # fix linting and formatting, and regenerate docs
yarn check                    # format, lint, sort, typecheck, core purity and docs freshness checks
yarn test-unit                # unit tests
yarn turbo test-integration   # integration tests (cli)
```

Run `yarn check`, `yarn test-unit` and `yarn turbo test-integration` before opening a pull request. CI runs the same checks.

## Layout

- `packages/core` is the pure planning core and the plugin contract; it does no I/O, and `yarn check` enforces this.
- `packages/cli` is the `tallyrelease` binary with config loading, git, forge and CI integration.
- `packages/plugins` holds the built-in plugins (`node`, `php`, `go`, `kustomize`, `dart`, `changesets`), which use only the public API of `@tallyrelease/core`.
- `packages/docs` generates the reference pages in `docs/`.
- `packages/tsconfig` holds the shared TypeScript configs.

The full design is in [`docs/design.md`](docs/design.md).

## Docs

`docs/cli.md`, `docs/configuration.md`, `docs/release-list.md` and `docs/errors.md` are generated from the code, and the git history drawings in `docs/assets/` from `docs/assets/histories/*.json`. `yarn fix` regenerates them, and `yarn check` fails when they are stale. Complete config examples in the docs start with `# tallyrelease.yaml` (or the `# yaml-language-server:` modeline) and are validated against the config schema by a test in `packages/docs`. Snippets that are not complete configs do not carry the line.

## Tests

- Prefer fakes at seams (`memoryFs`, `memoryCtx`, `memoryGit` from `@tallyrelease/core/testing`) over module mocks. Do not use `vi.mock` for modules.
- Core scenarios are YAML files in `packages/core/test/scenarios/`.
- Integration tests are named `*.integration-spec.ts`.
- Keep tests and harnesses small.

## Commits and pull requests

Commits and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/), for example `fix(cli): ...` or `feat(core): ...`. commitlint checks them in a git hook. tallyrelease releases itself from these commits: `feat`, `fix`, `perf`, `revert` and breaking changes produce a release; `docs`, `chore`, `test` and similar types do not.

Keep pull requests focused on one change and add a test for behavior changes.

## Licence

By contributing you agree that your contributions are licensed under the [Apache-2.0](LICENSE) licence.
