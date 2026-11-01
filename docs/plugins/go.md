# The go plugin

The `go` plugin turns every Go module of a repository into a unit and checks the major version path rule before a release. Units version through tags and have no version file.

```yaml
plugins:
  go: {}
```

## Discovery

Every `go.mod` in the repository is a unit, including nested modules. `vendor` at the top level and `node_modules` are not searched.

- **Id.** The last segment of the module directory, or the repository name for `.`.
- **Root.** The directory of the `go.mod`.
- **Meta.** The path of the `module` line is stored as `meta.go.modulePath`.

## Edges

Relative `replace` directives create edges, in single-line and block form:

```text
replace example.com/b => ../b
```

The edge goes from the replaced module (`b`) to the module that declares the directive, is unpinned and has the reason `replace: <module>`. A replacement is ignored when its target is not a relative path, resolves outside the repository or is not the root of another `go` unit. `require` directives add no edges; declare those with `deps` in the config.

## Inputs

None. `go.mod` and `go.sum` belong to the unit that contains them. Add other files, such as `go.work`, with the top-level `globalInputs` key.

## Version files

None. The module version is the git tag.

## Version source and tag format

The version source is `tag`. The tag format follows the convention of Go for modules below the repository root:

| Unit root    | Tag format              | Example tag         |
| :----------- | :---------------------- | :------------------ |
| `.`          | `v{version}`            | `v1.4.0`            |
| `libs/mathx` | `libs/mathx/v{version}` | `libs/mathx/v1.4.0` |

Set `units.<root>.tagFormat` to override it.

## Schemes

The plugin registers no scheme. Units use `semver`, which is what Go modules require.

## Options

The plugin has no options. Only the core-owned `globalInputs: false` is accepted on the entry.

## Validation

The `validate` hook enforces the major version path rule for every `go` unit with a pending release. The major of the next version decides the required module path:

- From `2.0.0` on, the module path must end in `/v<major>`, for example `example.com/mod/v2`.
- Below `2.0.0`, the module path must not end in `/vN` with `N` of 2 or higher.

A violation throws, so the command fails with [`E_PLUGIN_HOOK`](../errors.md#e_plugin_hook). The reason in the message starts with `E_GO_MAJOR_PATH:` and names the unit, the next version and the module path, for example:

```text
plugin "go" failed in validate: E_GO_MAJOR_PATH: unit "mathx" releases 2.0.0 but module path "example.com/mathx" must end in "/v2"
```

`E_GO_MAJOR_PATH` is a message prefix, not a registered error code, so it has no entry in [errors.md](../errors.md). Change the `module` line in the same change as the breaking commit. Until then every command that runs the `validate` hooks on a plan with the unit fails. A unit without a `module` line is skipped.

## Example

```yaml
plugins:
  go: {}
units:
  libs/mathx: { release: true }
  cmd/tool: { release: true, tags: [docker] }
```

With `replace example.com/mathx => ../../libs/mathx` in `cmd/tool/go.mod`, a change to `libs/mathx` also affects `tool`.
