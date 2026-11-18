import { defaultUnitId } from "@tallyrelease/core";

const GLOB_META = /[[\]{}()!*?+@\\]/g;

/** Repo-relative path of `file` inside unit `root` (`.` is the repo root). */
export const joinRoot = (root: string, file: string): string =>
	root === "." ? file : `${root}/${file}`;

/** Glob for `file` inside `dir`, ignoring trailing slashes on `dir`. */
export const globIn = (dir: string, file: string): string =>
	`${dir.replace(/\/+$/, "")}/${file}`;

/** Unit root of a matched `<root>/<file>` path. */
export const rootOf = (path: string, file: string): string =>
	path.slice(0, -`/${file}`.length);

/** Escapes glob syntax so `path` matches literally. */
export const escapeGlob = (path: string): string =>
	path.replace(GLOB_META, "\\$&");

/** Joins `rel` onto `root` and normalizes; undefined when it leaves the repo. */
export const resolvePath = (root: string, rel: string): string | undefined => {
	const out: string[] = [];
	for (const part of [...root.split("/"), ...rel.split("/")]) {
		if (part === "..") {
			if (out.pop() === undefined) {
				return undefined;
			}
		} else if (part !== "" && part !== ".") {
			out.push(part);
		}
	}

	return out.length === 0 ? "." : out.join("/");
};

/** True when `path` is `root` or below it. */
export const isInside = (path: string, root: string): boolean =>
	root === "." || path === root || path.startsWith(`${root}/`);

/** Directory of a repo-relative file path; `.` for top-level files. */
export const dirOf = (file: string): string =>
	file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";

/** Unit id from a directory path: `/` becomes `-`; the root `.` uses the repository name. */
export const pathUnitId = (root: string, repoName: string): string =>
	root === "." ? defaultUnitId(root, repoName) : root.replaceAll("/", "-");
