/** Repo-relative path of `file` inside unit `root` (`.` is the repo root). */
export const joinRoot = (root: string, file: string): string =>
	root === "." ? file : `${root}/${file}`;

/** Glob for `file` inside `dir`, ignoring trailing slashes on `dir`. */
export const globIn = (dir: string, file: string): string =>
	`${dir.replace(/\/+$/, "")}/${file}`;

/** Unit root of a matched `<root>/<file>` path. */
export const rootOf = (path: string, file: string): string =>
	path.slice(0, -`/${file}`.length);
