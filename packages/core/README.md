# @tallyrelease/core

Pure planning core and plugin contract for [tallyrelease](https://github.com/abinnovision/tallyrelease). It does no I/O: files and git are read through the injected `ReadonlyFs`, `Ctx` and `GitReader`.

Most users want [`@tallyrelease/cli`](https://www.npmjs.com/package/@tallyrelease/cli) instead. Install this package to write an ecosystem plugin or to embed the planner.

## Plugins

A plugin is defined with `definePlugin`, which checks the name and `apiVersion: 1`.

```ts
import { definePlugin, PLUGIN_API_VERSION } from "@tallyrelease/core";

export const example = definePlugin({
  apiVersion: PLUGIN_API_VERSION,
  name: "example",
  discover: (ctx) =>
    ctx.fs.glob(["packages/*"], { dirs: true }).map((root) => ({
      id: root.split("/").at(-1) ?? root,
      root,
    })),
});
```

See `Plugin` in [`src/plugin.ts`](https://github.com/abinnovision/tallyrelease/blob/main/packages/core/src/plugin.ts) for the available hooks (`discover`, `edges`, `inputs`, `versionFiles`, `schemes`, `intent`).

Core always registers the `semver` scheme and the Conventional Commits intent source. A plugin that reads commit messages can use `parseCommit` for the same parsing.

### Tag formats

A plugin that sets `tagFormat` on its units can check the format with the same rules core applies. `compileTagFormat(format, unitId)` throws `E_TAG_FORMAT` unless `{version}` occurs exactly once, and returns a `TagFormat` whose `match(tag)` gives the `{version}` part of a matching tag. `renderTag(unit, version)` renders the tag of a version.

```ts
import { compileTagFormat, renderTag } from "@tallyrelease/core";

const format = compileTagFormat("{id}-v{version}", "web");
format.match("web-v1.2.0"); // "1.2.0"
renderTag({ id: "web", tagFormat: "{id}-v{version}" }, "1.2.0"); // "web-v1.2.0"
```

## Testing

The `@tallyrelease/core/testing` export provides in-memory fakes: `memoryFs`, `memoryCtx` and `memoryGit`. The `@tallyrelease/core/testing/conformance` export provides `gitReaderConformance`, a shared `GitReader` spec that requires vitest.

## Licence

Apache-2.0
