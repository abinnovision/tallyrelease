type Token =
	| { type: "ident"; value: string }
	| { type: "string"; value: string; literal: boolean }
	| { type: "punct"; value: string };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;
const HEREDOC = /^<<-?([A-Za-z_][A-Za-z0-9_-]*)[ \t]*\r?\n/;

/** Tokens of HCL native syntax, without comments; heredocs become non-literal strings. */
const tokenize = (text: string): Token[] => {
	const tokens: Token[] = [];
	let i = 0;

	const skipTemplate = (): void => {
		let depth = 1;
		while (i < text.length && depth > 0) {
			const c = text[i];
			if (c === '"') {
				i++;
				readString();
			} else {
				if (c === "{") {
					depth++;
				} else if (c === "}") {
					depth--;
				}

				i++;
			}
		}
	};

	// Reads after the opening quote up to and past the closing one.
	const readString = (): { value: string; literal: boolean } => {
		let value = "";
		let literal = true;
		while (i < text.length) {
			const c = text[i] as string;
			const next = text[i + 1];
			if (c === '"') {
				i++;
				break;
			} else if (c === "\\") {
				// Only quote and backslash escapes are decoded; others make the value non-literal.
				if (next === '"' || next === "\\") {
					value += next;
				} else {
					literal = false;
				}

				i += 2;
			} else if (
				(c === "$" || c === "%") &&
				next === c &&
				text[i + 2] === "{"
			) {
				value += `${c}{`;
				i += 3;
			} else if ((c === "$" || c === "%") && next === "{") {
				literal = false;
				i += 2;
				skipTemplate();
			} else {
				value += c;
				i++;
			}
		}

		return { value, literal };
	};

	while (i < text.length) {
		const c = text[i] as string;
		const next = text[i + 1];
		if (c === "#" || (c === "/" && next === "/")) {
			while (i < text.length && text[i] !== "\n") {
				i++;
			}
		} else if (c === "/" && next === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
		} else if (c === '"') {
			i++;
			tokens.push({ type: "string", ...readString() });
		} else if (
			c === "<" &&
			next === "<" &&
			HEREDOC.test(text.slice(i, i + 256))
		) {
			const match = HEREDOC.exec(text.slice(i, i + 256)) as RegExpExecArray;
			const marker = match[1];
			i += match[0].length;
			while (i < text.length) {
				const eol = text.indexOf("\n", i);
				const line = text.slice(i, eol === -1 ? text.length : eol);
				i = eol === -1 ? text.length : eol + 1;
				if (line.trim() === marker) {
					break;
				}
			}

			tokens.push({ type: "string", value: "", literal: false });
		} else if (IDENT_START.test(c)) {
			const start = i;
			while (i < text.length && IDENT_PART.test(text[i] as string)) {
				i++;
			}

			tokens.push({ type: "ident", value: text.slice(start, i) });
		} else {
			if (!/\s/.test(c)) {
				tokens.push({ type: "punct", value: c });
			}

			i++;
		}
	}

	return tokens;
};

const entries = (value: unknown): [string, unknown][] => {
	if (Array.isArray(value)) {
		return value.flatMap(entries);
	}

	return typeof value === "object" && value !== null
		? Object.entries(value)
		: [];
};

/** A `module` block's name and literal `source`. */
export interface ModuleCall {
	name: string;
	source: string;
}

const isPunct = (t: Token | undefined, value: string): boolean =>
	t?.type === "punct" && t.value === value;

/** Module calls of a `.tf` or `.tofu` file whose `source` is a literal string. */
export const moduleCalls = (text: string): ModuleCall[] => {
	const tokens = tokenize(text);
	const calls: ModuleCall[] = [];
	let depth = 0;
	let current: string | undefined;

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i] as Token;
		const label = tokens[i + 1];
		const value = tokens[i + 2];
		if (isPunct(t, "{")) {
			depth++;
		} else if (isPunct(t, "}")) {
			depth = Math.max(0, depth - 1);
			current = depth === 0 ? undefined : current;
		} else if (t.type !== "ident") {
			continue;
		} else if (
			depth === 0 &&
			t.value === "module" &&
			label?.type !== "punct" &&
			isPunct(value, "{")
		) {
			current = label?.value;
			depth = 1;
			i += 2;
		} else if (
			depth === 1 &&
			current !== undefined &&
			t.value === "source" &&
			isPunct(label, "=") &&
			value?.type === "string" &&
			value.literal
		) {
			calls.push({ name: current, source: value.value });
		}
	}

	return calls;
};

/** Module calls of a `.tf.json` or `.tofu.json` file. */
export const moduleCallsJson = (text: string): ModuleCall[] => {
	const doc = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
	const calls: ModuleCall[] = [];
	for (const [key, modules] of entries(doc)) {
		if (key !== "module") {
			continue;
		}

		for (const [name, body] of entries(modules)) {
			for (const [attr, source] of entries(body)) {
				if (attr === "source" && typeof source === "string") {
					calls.push({ name, source });
				}
			}
		}
	}

	return calls;
};
