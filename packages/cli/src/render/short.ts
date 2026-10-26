/** Abbreviated commit sha, `fallback` when absent. */
export const short = (sha: string | null | undefined, fallback = "-"): string =>
	sha?.slice(0, 7) ?? fallback;
