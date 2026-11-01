# The dart plugin

The `dart` plugin turns every Dart or Flutter package into a unit and rewrites the `version:` line of `pubspec.yaml` on release. Units use the `semver` scheme.

```yaml
plugins:
  dart: {}
```

## Discovery

Every `pubspec.yaml` is a unit, except those below a directory that starts with `.` (such as `.dart_tool`) or is named `build` or `example`. A root `pubspec.yaml` is the unit `.`, unless it only anchors a workspace:

- **Workspace root.** A root `pubspec.yaml` with a `workspace:` key, or next to a root `melos.yaml`, and without a top-level `version:` is not a unit. A root with `version:` stays the unit `.`.
- **Overlay.** A `units: { ".": ... }` entry on a skipped workspace root creates a config-only unit with `version: tag`. See [config-only units](config-only.md).
- **Id.** The last segment of the unit root, or the repository name for `.`.
- **Root.** The directory of the `pubspec.yaml`.
- **Meta.** The `name` of the pubspec is stored as `meta.dart.packageName`.

A pubspec with invalid YAML fails the command with a message that names the file.

## Edges

Edges connect units by package name. Dependencies on packages outside the repository are ignored. The edge reason is `<field>: <package>`.

| Field                  | Entry                                                    | Pinned |
| :--------------------- | :------------------------------------------------------- | :----- |
| `dependencies`         | `path:` map naming a unit                                | Yes    |
| `dependencies`         | exact version such as `1.2.0` or `1.2.0-rc.1+3`          | Yes    |
| `dependencies`         | range (`^1.0.0`, `any`, `>=1.0.0 <2.0.0`) or empty value | No     |
| `dev_dependencies`     | any `path:` map, version or empty value                  | No     |
| `dependency_overrides` | any `path:` map, version or empty value                  | No     |

The empty value is the `shared:` form used by pub workspace members. Other maps (`git:`, `hosted:`, `sdk:`) and YAML numbers such as `shared: 1.0` add no edge.

A `path:` dependency in `dependencies` is pinned because the dependent bundles the code of the dependency. The manifest of the dependent does not change, but the shipped artifact does.

**Behaviour change.** A released path dependency now patches its dependents under `propagate: auto`, where it used to give a rebuild. Two released dart units in different release PRs that are linked by a path dependency fail with [`E_RELEASE_PR_SPLIT_EDGE`](../errors.md#e_release_pr_split_edge). Put both units in a fixed group, release them in one release PR, or set `propagate: rebuild` on the dependent. The first run after upgrading can release more units than before.

If two units declare the same package name, the plugin warns with `W_PLUGIN` and uses the later unit. `pubspec_overrides.yaml` adds no edges. Declare such dependencies with `deps` in the config.

## Inputs

A change to a file below is a global input and affects every unit:

- `pubspec.lock`
- `melos.yaml`
- `analysis_options.yaml` at the repository root
- `pubspec.yaml` at the repository root, only when it is a skipped workspace root

Set `globalInputs: false` on the plugin entry to drop these defaults, or add globs with the top-level `globalInputs` key.

## Version files

`<root>/pubspec.yaml` is the version file. On release the plugin:

- replaces the top-level `version:` line in place, keeping its quotes and trailing comment. A `+build` suffix is dropped, so `1.2.0+5` becomes `1.2.1`,
- adds `version: <next>` on a new line after `name:` when the line is missing,
- sets exact version pins under the top-level `dependencies:` to the new version when they name a unit released together with it, keeping quotes and trailing comments, and
- keeps the line endings of the file (LF or CRLF).

Ranges, maps, `dev_dependencies` and `dependency_overrides` are not rewritten, and neither are numeric scalars such as `shared: 1.0`. Only scalar constraints directly under `dependencies:` are rewritten.

Version files exist only for released units. An unreleased unit with an exact pin on a released unit keeps the old pin, and `pub get` fails after the release. Use `^` or `any` there.

## Version source and tag format

The version source is `file`. Set `units.<root>.version: tag` to version a package through tags only. The tag format is the core default, `{id}-v{version}` or `v{version}` for the unit `.`, unless `defaults.tagFormat` or the unit sets one.

## Schemes

The plugin registers no scheme. Every unit uses `semver` unless `units.<root>.scheme` selects `calver`.

## Options

The plugin has no options. Only the core-owned `globalInputs: false` is accepted on the entry. Other keys fail with [`E_PLUGIN_OPTIONS`](../errors.md#e_plugin_options).

## Migrating from `flutter`

Earlier versions registered a `flutter` scheme with versions of the form `x.y.z+build` and defaulted private Flutter apps to it. Units now use `semver`, and `scheme: flutter` fails as an unknown scheme.

- **Old tags.** Tags such as `v1.2.0+5` keep matching under `semver`. The next release is `x.y.(z+1)`, so a fix on `1.2.0+5` releases `1.2.1`.
- **Ordering.** `semver` ignores build metadata when comparing. Tags with an equal core are ordered by tag name, so `v1.2.0+9` sorts above `v1.2.0+10`.
- **Build offset.** `plugins.dart.buildOffset: N` is rejected with `E_PLUGIN_OPTIONS`. Use `units.<glob>.buildNumber.offset: N`, for example `units: { "apps/*": { buildNumber: { offset: N } } }`.
- **Build number.** The `buildNumber` field of the release list is the source of the build number. The version no longer carries it.

## Example

```yaml
plugins:
  dart: {}
units:
  apps/mobile: { release: true }
  packages/shared: { release: true }
```

With a pub workspace whose members are `apps/mobile` and `packages/shared`, a fix in `packages/shared` releases `shared`. When `mobile` depends on it through `path:`, the pinned edge also gives `mobile` a patch release, and both units are written to their `pubspec.yaml` by `version`.
