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
yarn fix                      # fix linting and formatting
yarn check                    # format, lint, sort, typecheck and core purity checks
yarn test-unit                # unit tests
yarn turbo test-integration   # integration tests (cli)
```

Run `yarn check`, `yarn test-unit` and `yarn turbo test-integration` before opening a pull request. CI runs the same checks.

## Layout

- `packages/core` is the pure planning core and the plugin contract. It does no I/O; files and git are read only through injected `ReadonlyFs`, `Ctx` and `GitReader`. `yarn check` enforces this.
- `packages/cli` is the `tallyrelease` binary with config loading, git, forge, CI integration and the built-in plugins (`node`, `php`, `kustomize`). Plugins use only the public API of `@tallyrelease/core`.

The full design is in [`docs/design.md`](docs/design.md).

## Tests

- Prefer fakes at seams (`memoryFs`, `memoryCtx`, `memoryGit` from `@tallyrelease/core/testing`) over module mocks. Do not use `vi.mock` for modules.
- Core scenarios are YAML files in `packages/core/test/scenarios/`.
- Integration tests are named `*.integration-spec.ts`.
- Keep tests and harnesses small.

## Commits and pull requests

Commits and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/), for example `fix(cli): ...` or `feat(core): ...`. commitlint checks them in a git hook. tallyrelease releases itself from these commits: `feat` and `fix` produce a release, `docs`, `chore`, `test` and similar types do not.

Keep pull requests focused on one change and add a test for behavior changes.

## License

By contributing you agree that your contributions are licensed under the [Apache-2.0](LICENSE) license.
