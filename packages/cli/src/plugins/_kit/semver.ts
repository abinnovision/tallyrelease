/** Regex source for `major.minor.patch`. */
export const NUMBERS = String.raw`\d+\.\d+\.\d+`;

/** Regex source for an optional `-prerelease` suffix. */
export const PRERELEASE = String.raw`(?:-[0-9A-Za-z.-]+)?`;

/** Regex source for an optional `+build` suffix. */
export const BUILD = String.raw`(?:\+[0-9A-Za-z.-]+)?`;
