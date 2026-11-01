# The node plugin

The `node` plugin turns every package of an npm, Yarn or pnpm repository into a unit and rewrites `package.json` on release.

```yaml
plugins:
  node: {}
```

## Discovery

The plugin looks for workspace patterns first:

1. `packages` of `pnpm-workspace.yaml`, if the file exists (an empty or missing list means no packages).
2. Otherwise `workspaces` of the root `package.json`, as an array or as `{ packages: [...] }`.

Each pattern is matched against `<pattern>/package.json`. Patterns that start with `!` remove the packages they match. The root `package.json` is a unit only when a pattern matches it.

Without workspace patterns, a root `package.json` is the single unit `.`. Without any `package.json`, nothing is discovered.

- **Id.** The last segment of the unit root, or the repository name for `.`. It is not the package name, so two packages in directories with the same name clash with `E_DUPLICATE_UNIT`. Set `units.<root>.id` to rename one.
- **Root.** The directory of the `package.json`.
- **Meta.** The `name` of the manifest is stored as `meta.node.packageName`. Edges and the [changesets plugin](changesets.md) use it.

## Edges

Edges connect units by package name. Dependencies on packages outside the repository are ignored.

| Field                  | Pinned                                                |
| :--------------------- | :---------------------------------------------------- |
| `dependencies`         | When the range is an exact version or `*`, see below. |
| `optionalDependencies` | Same as `dependencies`.                               |
| `peerDependencies`     | Never.                                                |
| `devDependencies`      | Never.                                                |

A range is pinned when it is `*`, or `X.Y.Z` with an optional prerelease and build suffix, optionally prefixed with `=` or `v`; each of these may also start with `workspace:`. Ranges such as `^1.2.0`, `~1.2.0` and `workspace:^` are unpinned. The edge reason is `<field>: <package>`.

If two units declare the same package name, the plugin warns with `W_PLUGIN` and uses the later unit.

## Inputs

A change to a file below is a global input and affects every unit:

- `yarn.lock`, `package-lock.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`
- `.yarnrc.yml`, `.yarn/patches/**`
- `tsconfig*.json`, `turbo.json`
- `package.json` at the repository root, only when the repository has workspace patterns

Set `globalInputs: false` on the plugin entry to drop these defaults, or add globs with the top-level `globalInputs` key.

## Version files

`<root>/package.json` is the version file of a released unit with `version: file`, which is the default of this plugin. On release the plugin:

- sets `version` to the next version,
- rewrites pinned ranges in `dependencies` and `optionalDependencies` that name a unit released in the same release PR to the new version, keeping the `workspace:`, `=` or `v` prefix. `*` and ranges such as `^1.0.0` are left alone, and
- keeps the indentation, key order, line endings (LF or CRLF) and the trailing newline of the file.

## Version source and tag format

The version source is `file`. Set `units.<root>.version: tag` to version a package through tags only; the file is then not written. The tag format is the core default, `{id}-v{version}` or `v{version}` for the unit `.`, unless `defaults.tagFormat` or the unit sets one.

## Schemes

The plugin registers no scheme. Units use `semver` unless `units.<root>.scheme` selects `calver`.

## Options

The plugin has no options. Only the core-owned `globalInputs: false` is accepted on the entry.

## Example

```yaml
plugins:
  node: {}
  changesets: {}
units:
  packages/core: { release: true }
  packages/cli: { release: true }
```

With `workspaces: ["packages/*"]` in the root `package.json`, this releases `core` and `cli`. When `core` is released, a `"@acme/core": "1.2.0"` entry in the `dependencies` of `cli` is rewritten to the new version, and with the default `propagate: auto` the pinned edge also gives `cli` a patch release. See [configuration.md](../configuration.md) for every config key.
