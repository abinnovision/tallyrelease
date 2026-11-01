import { describe, expect, it } from "vitest";

import { frozenCopy } from "./util.js";

describe("frozenCopy", () => {
	it("returns a deep-frozen copy and leaves the original alone", () => {
		const value = { units: [{ id: "a", tags: ["x"] }] };
		const copy = frozenCopy(value);

		expect(copy).toEqual(value);
		expect(Object.isFrozen(copy.units[0]?.tags)).toBe(true);
		expect(() => copy.units.push({ id: "b", tags: [] })).toThrow(TypeError);
		expect(Object.isFrozen(value)).toBe(false);
	});
});
