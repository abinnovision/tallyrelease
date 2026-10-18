import { describe, expect, it } from "vitest";

import { defineCodes } from "./codes.js";
import { TallyError } from "./errors.js";

const doc = { cause: "c", fix: "f" };
const codes = defineCodes({ E_X: doc, W_X: doc });

describe("defineCodes", () => {
	it("rejects keys without an E_ or W_ prefix", () => {
		expect(() => {
			// @ts-expect-error BAD is not a code
			defineCodes({ BAD: doc });
		}).not.toThrow();
	});

	it("rejects unknown codes and codes of the other kind", () => {
		expect(() => {
			// @ts-expect-error unknown code
			codes.error("E_Y", "m");
			// @ts-expect-error warning code passed to error
			codes.error("W_X", "m");
			// @ts-expect-error error code passed to warning
			codes.warning("E_X", "m");
		}).not.toThrow();
	});

	it("builds a TallyError and passes details through", () => {
		const error = codes.error("E_X", "m");
		expect(error).toBeInstanceOf(TallyError);
		expect(error.code).toBe("E_X");
		expect(error.details).toEqual({});
		expect(codes.error("E_X", "m", { a: 1 }).details).toEqual({ a: 1 });
	});

	it("builds a warning with optional fields", () => {
		expect(codes.warning("W_X", "m", { unit: "a" })).toEqual({
			code: "W_X",
			message: "m",
			unit: "a",
		});
		expect(codes.warning("W_X", "m")).toEqual({ code: "W_X", message: "m" });
	});

	it("exposes the docs", () => {
		expect(codes.docs.E_X).toBe(doc);
	});
});
