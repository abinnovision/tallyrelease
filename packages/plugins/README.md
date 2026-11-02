# @tallyrelease/plugins

Built-in ecosystem plugins of [tallyrelease](https://github.com/abinnovision/tallyrelease):

- [`node`](https://github.com/abinnovision/tallyrelease/blob/main/docs/plugins/node.md): npm, Yarn and pnpm packages.
- [`php`](https://github.com/abinnovision/tallyrelease/blob/main/docs/plugins/php.md): Composer projects.
- [`go`](https://github.com/abinnovision/tallyrelease/blob/main/docs/plugins/go.md): Go modules.
- [`kustomize`](https://github.com/abinnovision/tallyrelease/blob/main/docs/plugins/kustomize.md): kustomization directories.
- [`dart`](https://github.com/abinnovision/tallyrelease/blob/main/docs/plugins/dart.md): Dart and Flutter packages.
- [`changesets`](https://github.com/abinnovision/tallyrelease/blob/main/docs/plugins/changesets.md): `.changeset/*.md` files as an intent source.

The plugins are pure: they read files only through the `Ctx` that `@tallyrelease/core` injects.

Most users want [`@tallyrelease/cli`](https://www.npmjs.com/package/@tallyrelease/cli) instead, which bundles these plugins.
