/** Parses a JSON manifest; a syntax error names the file. */
export const parseJson = (path: string, raw: string): unknown => {
	try {
		return JSON.parse(raw);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`invalid JSON in ${path}: ${reason}`, { cause: error });
	}
};
