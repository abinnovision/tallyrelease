# The changesets plugin

The `changesets` plugin reads [Changesets](https://github.com/changesets/changesets) files as an intent source, so a release can be driven by `.changeset/*.md` files next to Conventional Commits. It discovers no units, so enable it next to the plugin of your ecosystem.

```yaml
plugins:
  node: {}
  changesets: {}
```

## Intent

The plugin contributes one intent source, `changesets`, to the built-in Conventional Commits source. Each `.changeset/*.md` file has a frontmatter that maps keys to bump levels, and a body that is the summary:

```md
---
"@acme/core": minor
cli: patch
---

Add the `--json` flag

Prints the plan as JSON.
```

- **Keys.** A key is a unit id or a package name that a plugin stores in `meta.<plugin>.packageName`, such as the `name` of a `package.json`. A unit id wins over a package name. A key that matches no unit warns with `W_UNIT_UNKNOWN`.
- **Levels.** `major` is a breaking `feat`, `minor` a `feat` and `patch` a `fix`. `none` is skipped, and any other level warns with `W_PLUGIN`.
- **Summary.** The first line of the body is the subject and the rest is the body.
- **Changes.** A changeset becomes one change per bump level, each with explicit `units` and `files: [<path>]`.
- **Skipped files.** A file without frontmatter is skipped with a `W_PLUGIN` warning, except `.changeset/README.md`. A frontmatter that is invalid YAML or not a mapping fails the command.

## Range

A changeset counts for a unit only when a commit in the unit's range touched the file, so a changeset that is still present after a release does not bump again. `collect` cannot tell an added file from a modified one, so editing an old changeset counts it again in that range.

## Consumed files

Every change carries its file in `files`. The release commit deletes the file once every unit named by the changes that carry it is released by that commit: `version` removes it from the working tree (`would delete <path>` with `--dry-run`) and the release PR commit drops it. When the named units release in different release PRs, no release commit deletes the file; remove it by hand after they are released.

## Discovery, edges, inputs and version files

None. The plugin declares no `discover`, `edges`, `inputs` or `versionFiles` hook, registers no scheme and has no `validate` or `changelog` hook.

## Options

The plugin has no options. Any key on the entry other than the core-owned `globalInputs` fails with [`E_PLUGIN_OPTIONS`](../errors.md#e_plugin_options).

## Example

```yaml
plugins:
  node: {}
  changesets: {}
units:
  packages/core: { release: true }
  packages/cli: { release: true }
```

A changeset with `"@acme/core": minor` releases `core` with a minor bump, and when `cli` depends on `core`, the propagation policy decides whether `cli` follows.
