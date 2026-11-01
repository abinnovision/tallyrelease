# The php plugin

The `php` plugin turns a Composer project and its local path repositories into units. It has no version file: units version through tags.

```yaml
plugins:
  php: {}
```

## Discovery

The root `composer.json` makes the unit `.`. Without a root `composer.json`, nothing is discovered.

Every `repositories` entry of the root manifest with `type: path` adds the units that match its `url` as a glob, such as `packages/*`, where the directory holds a `composer.json`. The leading `./` and trailing slashes of the url are ignored; a url that starts with `../` is skipped.

- **Id.** The last segment of the unit root, or the repository name for `.`.
- **Root.** The directory of the `composer.json`.
- **Meta.** The `name` of the manifest is stored as `meta.php.packageName`.

## Edges

Edges connect units by package name; packages outside the repository are ignored.

| Field         | Pinned                                   |
| :------------ | :--------------------------------------- |
| `require`     | When the constraint is exact, see below. |
| `require-dev` | Never.                                   |

A constraint is pinned when it is `self.version`, or `X.Y.Z` (also `X.Y.Z.W`) with an optional prerelease suffix, optionally prefixed with `=` or `v`. Constraints such as `^1.2`, `~1.2` and `*` are unpinned. The edge reason is `<field>: <package>`.

## Inputs

`composer.lock` is a global input. Set `globalInputs: false` on the plugin entry to drop it, or add globs with the top-level `globalInputs` key.

## Version files

None. `composer.json` carries no version, as Packagist reads versions from tags.

## Version source and tag format

The version source is `tag`. `units.<root>.version: file` is accepted but writes nothing, since the plugin has no version file. The tag format is the core default, `{id}-v{version}` or `v{version}` for the unit `.`, unless `defaults.tagFormat` or the unit sets one.

To keep a version string in other files, use [`versionFiles` on the unit](config-only.md).

## Schemes

The plugin registers no scheme. Units use `semver` unless `units.<root>.scheme` selects `calver`.

## Options

The plugin has no options. Only the core-owned `globalInputs: false` is accepted on the entry.

## Example

```yaml
plugins:
  php: {}
units:
  .: { release: true }
  packages/lib: { release: true }
```

With `{ "repositories": [{ "type": "path", "url": "packages/*" }] }` in the root `composer.json`, the root and each package become units. A package that the root requires with `"acme/lib": "1.4.0"` is a pinned dependency, so with the default `propagate: auto` a release of `lib` also gives the released root a patch release.
