# The dart plugin

The `dart` plugin turns every Dart or Flutter package into a unit and rewrites the `version:` line of `pubspec.yaml` on release. It registers the `flutter` scheme.

```yaml
plugins:
  dart: {}
```

## Discovery

Every `pubspec.yaml` is a unit, except those below a directory that starts with `.` (such as `.dart_tool`) or is named `build` or `example`. A root `pubspec.yaml` is the unit `.`.

- **Id.** The last segment of the unit root, or the repository name for `.`.
- **Root.** The directory of the `pubspec.yaml`.
- **Meta.** The `name` of the pubspec is stored as `meta.dart.packageName`, and the option `buildOffset` as `meta.dart.buildOffset` when set.

A pubspec with invalid YAML fails the command with a message that names the file.

## Edges

A dependency with a `path:` key on another `dart` unit, matched by package name, is an unpinned edge. The fields are `dependencies`, `dev_dependencies` and `dependency_overrides`; the edge reason is `<field>: <package>`.

Dependencies resolved by version, as between members of a pub workspace, and `pubspec_overrides.yaml` add no edges. Declare them with `deps` in the config.

## Inputs

`pubspec.lock` is a global input. Set `globalInputs: false` on the plugin entry to drop it, or add globs with the top-level `globalInputs` key.

## Version files

`<root>/pubspec.yaml` is the version file. The top-level `version:` line is replaced in place, keeping its quotes and trailing comment. A pubspec without that line gets `version: <next>` on a new line after `name:`.

## Version source and tag format

The version source is `file`. Set `units.<root>.version: tag` to version a package through tags only. The tag format is the core default, `{id}-v{version}` or `v{version}` for the unit `.`, unless `defaults.tagFormat` or the unit sets one.

## Schemes

The plugin registers `flutter`, versions of the form `x.y.z+build`. The build number is the larger of the first-parent commit count plus `buildOffset` and the highest tagged build plus one. See the [scheme table](../plugins.md#schemes).

A unit defaults to `flutter` when its pubspec has `publish_to: none` and uses the Flutter SDK, which means `dependencies.flutter.sdk: flutter` or an `environment.flutter` constraint. Every other unit defaults to `semver`. `units.<root>.scheme` overrides the default, and `calver` is available to all units.

## Options

| Option        | Type                 | Default | Meaning                                                                                                                                |
| :------------ | :------------------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------- |
| `buildOffset` | non-negative integer | `0`     | Added to the first-parent commit count for `flutter` build numbers, for example to continue above builds uploaded before tallyrelease. |

Unknown keys fail with [`E_PLUGIN_OPTIONS`](../errors.md#e_plugin_options). The core-owned `globalInputs: false` is also accepted.

## Example

```yaml
plugins:
  dart: { buildOffset: 1000 }
units:
  apps/mobile: { release: true }
  packages/shared: { release: true }
```

With `buildOffset: 1000`, a fix on a flutter app whose latest release is `1.2.0+5`, made after 40 first-parent commits, releases `1.2.1+1040`. If a tag with build `2000` exists, the release is `1.2.1+2001` instead.
