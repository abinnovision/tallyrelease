# tallyrelease - Development Guide

tallyrelease computes affected build units and release plans for monorepos and single repos. The full design is in `docs/design.md`. Current status: v0.3 (release effects: version files, release PRs, tags, forge releases). This repo releases itself with tallyrelease (app-stack `tallyrelease: release`).

## Packages

Yarn 4 monorepo with Turbo orchestration. Names in parentheses are used for `turbo --filter`:

- `packages/core` (`@tallyrelease/core`) - pure planning core and the plugin contract. Exports `.` and `./testing` (fakes: `memoryFs`, `memoryCtx`, `memoryGit`).
- `packages/cli` (`@tallyrelease/cli`) - imperative shell, binary `tallyrelease`. Config loading, git, forge, CI integration, built-in plugins (`node`, `php`, `kustomize`).
- `packages/tsconfig` (`@internal/tsconfig`) - shared TypeScript configs.
- `packages/docs` (`@internal/docs`) - private generators for `docs/*.md`, run with Node type stripping.

## Commands

```bash
yarn build                    # Build all packages
yarn fix                      # Fix linting and formatting, and regenerate docs
yarn check                    # Format, lint, sort, typecheck, core purity and docs freshness checks
yarn test-unit                # Unit tests (all packages)
yarn turbo test-integration   # Integration tests (cli)
yarn clean                    # Remove build artifacts
make setup-dev                # Dependency check and install
make setup-worktree           # Same, for a linked git worktree
```

Every `make` target runs `tools/<target>.sh`; ordering and flags live in the script.

## Purity rules

- Core does no I/O. It reads files and git only through injected `ReadonlyFs`, `Ctx` and `GitReader`.
- Core `src/**` (except specs) must not import Node builtins or `@tallyrelease/cli`, and must not use `process`, `fetch`, `require` or `Buffer` (ESLint). Core `tsconfig.build.json` sets `"types": []`.
- `yarn workspace @tallyrelease/core check:purity` runs `tools/check-purity.mjs`, which bundles `src/index.ts` with esbuild for the neutral platform and fails on any Node builtin, including transitive ones. It runs as part of `yarn check`. `test/purity/violation.ts` is a deliberate violation used by `test/purity.spec.ts`.
- Built-in plugins (`packages/cli/src/plugins/**`) use only `@tallyrelease/core` public API and other plugin files; lint forbids Node builtins and relative imports out of the plugin folder, and `yarn workspace @tallyrelease/cli check:purity` bundles `src/plugins/index.ts` the same way.

## Testing

- Prefer fakes at seams over module mocks. Do not use `vi.mock` for modules and do not add `vitest-mock-extended`.
- Core: scenarios are YAML in `packages/core/test/scenarios/` served by `memoryGit`, `memoryFs`, `memoryCtx`.
- Cli: `main(argv, deps)` takes `deps = { env, cwd, stdout, stderr, git?, fs?, fsAt?, forge? }`. Most integration scenarios run in-process with `memoryGit`, `memoryFs` and a `fakeForge`. A few end-to-end tests use real git in tmp repos.
- `gitReaderConformance(makeReader)` runs against `memoryGit` and the real reader.
- Unit test projects are named `<package>#unit`, integration projects `<package>#integration` (`*.integration-spec.ts`).
- Keep tests and harnesses small.

## Conventions

- Node >=24, ESM only, Apache-2.0.
- Commits follow Conventional Commits; tallyrelease versions `packages/core` and `packages/cli` as the fixed group `tallyrelease` (one version) through release PRs on `tallyrelease/release/main/shared`.
- Keep comments short and about the current code.
