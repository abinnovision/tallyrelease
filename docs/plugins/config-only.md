# Config-only units

Not every releasable thing has a manifest. A config-only unit is a `units` entry for a root that no plugin discovered. It needs no plugin, releases with tags and a changelog, and rewrites the version in any text file through `versionFiles`. There is no `generic` plugin: this covers it.

## Enabling

Add the root under `units` in `tallyrelease.yaml`. The directory must exist, else the command fails with [`E_ROOT_MISSING`](../errors.md#e_root_missing).

```yaml
units:
  tools/setup:
    release: true
    versionFiles:
      - { file: docs/install.md, pattern: "setup@{version}" }
      - { file: tools/setup/env.sh }
```

## Discovery

- **Id.** `units.<root>.id`, else the last segment of the root, or the repository name for `.`.
- **Root.** The key of the entry. A key with `*` is a glob over existing roots and never creates a unit.
- **Owner.** `unit.plugin` is `config`.
- **Files.** The unit owns `<root>/**`, minus the roots of nested units. Set `include` and `exclude` to change that.

## Edges

None are derived, because no plugin reads a manifest. Declare dependencies with `deps`:

```yaml
deps:
  - { from: setup, to: docs-site, pinned: false }
```

## Inputs

None. Add files that affect every unit with the top-level `globalInputs` key.

## Version files

`versionFiles` belongs to the unit whichever plugin owns it, so it also works on units of `node`, `go` and the other plugins. Each entry names a `file` relative to the repository root, without `..` segments. A missing file fails with [`E_VERSION_FILE_MISSING`](../errors.md#e_version_file_missing). A path that is not valid fails with [`E_CONFIG`](../errors.md#e_config). Glob keys in `units` cannot set `versionFiles`; the config fails with [`E_CONFIG`](../errors.md#e_config).

### With a pattern

An entry with `pattern` is a text template with the tokens `{id}`, `{version}`, `{major}`, `{minor}` and `{patch}`. On release, every match that renders a version from the previous release up to, but not including, the next version is replaced with the next version:

```text
Run `npx setup@1.0.0`.   ->   Run `npx setup@1.1.0`.
```

- A pattern needs a version token (`{version}`, or `{major}`, `{minor}` and `{patch}`) and some literal text, and `{version}` cannot be mixed with the other three. Otherwise the command fails with `E_CONFIG`.
- A match is not replaced when it renders a version outside that range, for example one for another unit or a newer one.
- A first release leaves the file alone, because there is no earlier version to replace.
- A pattern that matches nothing warns with [`W_VERSION_FILE_NO_MATCH`](../errors.md#w_version_file_no_match).

### With markers

An entry without `pattern` rewrites the version on every line that carries `# x-tallyrelease-version` or `<!-- x-tallyrelease-version -->`. On such a line, the first word that parses as a version of the scheme (with an optional leading `v`) is replaced. This also happens on a first release.

```sh
VERSION=1.0.0 # x-tallyrelease-version
```

A file without a marker line that holds a version warns with [`W_MARKER_NO_MATCH`](../errors.md#w_marker_no_match).

Use markers for scripts, Dockerfiles, Helm values or docs that name the version, and patterns when the version sits in prose or in a larger string.

## Version source and tag format

The version source is `tag`: the version is the latest tag of the unit, and the first release uses `initialVersion` or the scheme's initial version (`1.0.0` for `semver`). A release creates a changelog at `<root>/CHANGELOG.md`. The tag format is `{id}-v{version}`, or `v{version}` for the unit `.`; `units.<root>.tagFormat` and `defaults.tagFormat` override it.

## Schemes

`semver` by default. `units.<root>.scheme` selects `calver`, or a scheme registered by another enabled plugin.

## Options

There is no plugin and so no `plugins` entry. The unit keys are listed in [configuration.md](../configuration.md).

## Validation

Version file patterns and tokens are checked when a plan is computed and by `tallyrelease check`. There is no `validate` hook.
