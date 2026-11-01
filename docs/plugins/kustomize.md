# The kustomize plugin

The `kustomize` plugin turns every directory with a kustomization into a unit. A unit is affected by its own directory and by the local files it references outside it, and the units it builds on are its dependencies.

```yaml
plugins:
  kustomize: {}
```

## Discovery

A unit is a directory that holds a `kustomization.yaml`, a `kustomization.yml` or a `Kustomization` file. A directory with more than one of them is one unit. By default the whole repository is searched; the option `paths` narrows that.

- **Id.** The unit root with `/` replaced by `-`, so `k8s/base/a` is `k8s-base-a`. The root `.` uses the repository name.
- **Root.** The directory of the kustomization.
- **Meta.** `meta.kustomize.refs` lists the references that point at other kustomization directories. Edges are built from it.

A kustomization that cannot be parsed warns with `W_PLUGIN` and is treated as empty.

The plugin reads these local path references, relative to the kustomization directory:

| Fields                                                                                                                            | Entries                                                    |
| :-------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------- |
| `resources`, `bases`, `components`, `crds`, `patchesStrategicMerge`, `configurations`, `transformers`, `generators`, `validators` | Paths. Entries that contain a newline are inline YAML.     |
| `patches`, `patchesJson6902`, `replacements`                                                                                      | The `path` of each entry.                                  |
| `openapi`                                                                                                                         | `path`.                                                    |
| `configMapGenerator`, `secretGenerator`                                                                                           | `files` (the path after `key=`), `envs` and `env`.         |
| `helmCharts`                                                                                                                      | `valuesFile` and `additionalValuesFiles`.                  |
| `helmGlobals`                                                                                                                     | `chartHome` when `helmCharts` is set; `charts` by default. |

Each reference is handled as follows:

- A remote reference (`://`, `git@`, `github.com/`, `?ref=`) and an absolute path are skipped.
- A path that leaves the repository warns with `W_PLUGIN`.
- A path to another kustomization directory becomes an edge, see below.
- A path inside the unit's own directory adds nothing, since the unit already owns it.
- Any other path that exists is added to the unit's `include`, together with `<path>/**`, so changes to that file or directory affect the unit. A path that does not exist warns with `W_PLUGIN`, except `helmGlobals.chartHome` (default `charts`), which is often fetched at build time and is added to `include` even when it does not exist.

When a unit has such extra paths, its `include` is the unit root plus those paths. An `include` in the config replaces it.

## Edges

A reference to another kustomization directory is an edge from the referenced unit to the unit that references it, for example from a base to the overlay that lists it under `resources`. Edges are unpinned and have the reason `<field>: <path>`.

## Inputs

None. Every input of a unit is a path it owns or references.

## Version files

None.

## Version source and tag format

The version source is `tag`. The tag format is the core default, `{id}-v{version}` or `v{version}` for the unit `.`, unless `defaults.tagFormat` or the unit sets one. Most kustomize units are only built, which is the default (`release: false`).

## Schemes

The plugin registers no scheme. Units use `semver` unless `units.<root>.scheme` selects `calver`.

## Options

| Option  | Type             | Default  | Meaning                                                                        |
| :------ | :--------------- | :------- | :----------------------------------------------------------------------------- |
| `paths` | array of strings | `["**"]` | Directory globs in which to look for kustomizations, for example `["k8s/**"]`. |

Unknown keys fail with [`E_PLUGIN_OPTIONS`](../errors.md#e_plugin_options). The core-owned `globalInputs: false` is also accepted.

## Example

```yaml
plugins:
  kustomize: { paths: ["deploy/**"] }
units:
  deploy/overlays/prod: { tags: [deploy] }
```

With `resources: [../../base]` in `deploy/overlays/prod/kustomization.yaml`, the unit `deploy-base` is a dependency of `deploy-overlays-prod`, so `tallyrelease affected --tag deploy` includes the overlay when the base changes.
