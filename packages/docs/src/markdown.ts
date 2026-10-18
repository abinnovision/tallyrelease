export const code = (s: string): string => `\`${s}\``;

export const cell = (s: string): string =>
	s.replaceAll("|", "\\|").replaceAll("\n", " ");
