/** Abbreviated commit sha, `-` when absent. */
export const short = (sha: string | null | undefined): string =>
	sha?.slice(0, 7) ?? "-";
