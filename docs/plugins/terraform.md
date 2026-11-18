# The terraform plugin

The `terraform` plugin turns every directory with Terraform or OpenTofu configuration into a unit. A unit is affected by its own directory, and the local modules it calls are its dependencies.

```yaml
# tallyrelease.yaml
plugins:
  terraform: {}
```

## Discovery

A unit is a directory that holds at least one `*.tf`, `*.tf.json`, `*.tofu` or `*.tofu.json` file. Root modules and local child modules are both units. Files below a `.terraform/` directory are skipped, since `terraform init` and `tofu init` download modules there. By default the whole repository is searched; the option `paths` narrows that.

- **Id.** The unit root with `/` replaced by `-`, so `infra/modules/vpc` is `infra-modules-vpc`. The root `.` uses the repository name.
- **Root.** The directory of the configuration files.
- **Meta.** `meta.terraform.modules` lists the module calls whose source is another unit, as `{ name, source }`. Edges are built from it.

The plugin reads the `source` of every top-level `module` block. Only a literal string counts; a source with an interpolation, a heredoc or an escape other than `\"` and `\\` is skipped. The scanner does not validate HCL. A `.tf.json` or `.tofu.json` file that is not valid JSON warns with `W_PLUGIN` and is skipped.

Each source is handled as follows:

- A source that does not start with `./` or `../` is not a local path (registry, git, `s3::` and other remote sources) and is skipped. This is the rule Terraform and OpenTofu use.
- A path that leaves the repository warns with `W_PLUGIN`.
- A path to another unit becomes an edge, see below.
- A path inside the unit's own directory adds nothing, since the unit already owns it.
- Any other path that exists, such as a module directory outside `paths`, is added to the unit's `include`, together with `<path>/**`. A path that does not exist warns with `W_PLUGIN`.

When a unit has such extra paths, its `include` is the unit root plus those paths. An `include` in the config replaces it.

## Edges

A module call to another unit is an edge from the called module to the calling unit. Edges are unpinned, have the dependency kind `runtime` and have the reason `module.<name>: <source>`.

## Inputs

None. Files read through `file()` or `templatefile()` outside the unit and var files passed on the command line are not detected; add them to the unit's `include`.

## Version files

None.

## Version source and tag format

The version source is `tag`. The tag format is the core default, `{id}-v{version}` or `v{version}` for the unit `.`, unless `defaults.tagFormat` or the unit sets one. Most units are only planned and applied, which is the default (`release: false`). Set `release: true` on a module that is published.

## Schemes

The plugin registers no scheme. Units use `semver` unless `units.<root>.scheme` selects `calver`.

## Options

| Option  | Type             | Default  | Meaning                                                                         |
| :------ | :--------------- | :------- | :------------------------------------------------------------------------------ |
| `paths` | array of strings | `["**"]` | Directory globs in which to look for configuration, for example `["infra/**"]`. |

Unknown keys fail with [`E_PLUGIN_OPTIONS`](../errors.md#e_plugin_options). The core-owned `globalInputs: false` is also accepted.

## Example

```yaml
# tallyrelease.yaml
plugins:
  terraform: { paths: ["infra/**"] }
units:
  infra/stacks/prod: { tags: [stack] }
```

With `module "vpc" { source = "../../modules/vpc" }` in `infra/stacks/prod/main.tf`, the unit `infra-modules-vpc` is a dependency of `infra-stacks-prod`, so `tallyrelease affected --tag stack` includes the prod stack when the module changes.
