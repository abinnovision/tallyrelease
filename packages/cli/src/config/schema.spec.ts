import { Ajv } from "ajv";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { configJsonSchema, configSchema } from "./schema.js";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

const validate = new Ajv({ strict: false }).compile(configJsonSchema());

describe("configJsonSchema", () => {
	it("accepts the repo config and an empty config", () => {
		expect(validate({})).toBe(true);
		expect(validate(parse(read("../../../../tallyrelease.yaml")))).toBe(true);
	});

	it("accepts $schema", () => {
		expect(validate({ $schema: "x" })).toBe(true);
	});

	it("accepts release keys", () => {
		expect(
			validate({
				defaults: { initialVersion: "0.1.0" },
				units: { a: { initialVersion: "2.0.0" } },
				branches: [
					{ name: "main", line: "default", channel: "beta" },
					{ name: "release/{major}.x", line: "maintenance" },
				],
				bumps: { types: { deps: "patch" }, preMajor: { breaking: "major" } },
			}),
		).toBe(true);
		expect(validate({ branches: [{ name: "main" }] })).toBe(false);
		expect(validate({ bumps: { types: { feat: "none" } } })).toBe(false);
	});

	it("accepts channels and the deprecated channel", () => {
		const rule = { name: "main", line: "default" };
		expect(
			validate({ branches: [{ ...rule, channels: { cut: "beta" } }] }),
		).toBe(true);
		expect(
			validate({
				branches: [
					{ ...rule, channel: "a", channels: { build: "a", cut: "b" } },
				],
			}),
		).toBe(true);
		expect(validate({ branches: [{ ...rule, channels: {} }] })).toBe(false);
		expect(validate({ branches: [{ ...rule, channels: { x: "a" } }] })).toBe(
			false,
		);
		expect(
			configSchema.safeParse({ branches: [{ ...rule, channels: {} }] }).success,
		).toBe(false);
		const schema = configJsonSchema() as unknown as {
			properties: {
				branches: {
					items: { properties: Record<string, { deprecated?: boolean }> };
				};
			};
		};
		expect(
			schema.properties.branches.items.properties["channel"]?.deprecated,
		).toBe(true);
	});

	it("accepts groups by units or tags", () => {
		expect(
			validate({
				groups: { sdk: { units: ["a"] }, apps: { tags: ["docker"] } },
			}),
		).toBe(true);
		expect(validate({ groups: { "a b": { units: ["a"] } } })).toBe(false);
		expect(validate({ groups: { sdk: { mode: "linked" } } })).toBe(false);
		expect(validate({ groups: { sdk: {} } })).toBe(false);
		expect(validate({ groups: {} })).toBe(false);
		expect(validate({ groups: { sdk: { units: ["a b"] } } })).toBe(false);
	});

	it("accepts attribution scopes", () => {
		for (const key of ["api/v2", "@acme/ui", "deps-dev"]) {
			const config = { attribution: { scopes: { [key]: ["a"] } } };
			expect(validate(config)).toBe(true);
			expect(configSchema.safeParse(config).success).toBe(true);
		}

		expect(validate({ attribution: { mode: "narrow" } })).toBe(true);
		expect(validate({ attribution: { mode: "wide" } })).toBe(false);
		expect(validate({ attribution: { nope: 1 } })).toBe(false);
		expect(validate({ attribution: { scopes: { api: [] } } })).toBe(false);
		for (const key of ["a b", "a(b)", "a,b"]) {
			const config = { attribution: { scopes: { [key]: ["a"] } } };
			expect(validate(config)).toBe(false);
			expect(configSchema.safeParse(config).success).toBe(false);
		}
	});

	it("rejects id, include, exclude and versionFiles on glob unit keys", () => {
		expect(
			configSchema.safeParse({
				units: { "apps/*": { release: true }, "apps/web": { id: "web" } },
			}).success,
		).toBe(true);
		expect(
			configSchema.safeParse({ units: { "apps/*": { id: "x" } } }).error
				?.issues,
		).toMatchObject([
			{
				path: ["units", "apps/*", "id"],
				message: 'unit overlay "apps/*" cannot set "id" on a glob key',
			},
		]);
	});

	it("accepts path or package on plugins, not both", () => {
		expect(validate({ plugins: { a: { path: "a.ts", x: 1 } } })).toBe(true);
		expect(validate({ plugins: { a: { package: "@acme/a" } } })).toBe(true);
		expect(validate({ plugins: { a: { package: "./a.js" } } })).toBe(false);
		expect(
			configSchema.safeParse({
				plugins: { a: { path: "a.ts", package: "a" } },
			}).error?.issues,
		).toMatchObject([
			{ path: ["plugins", "a"], message: "set path or package, not both" },
		]);
	});

	it("accepts buildNumber on glob keys with a non-negative integer offset", () => {
		expect(
			validate({ units: { "apps/*": { buildNumber: { offset: 1000 } } } }),
		).toBe(true);
		expect(validate({ units: { a: { buildNumber: {} } } })).toBe(true);
		expect(validate({ units: { a: { buildNumber: { offset: -1 } } } })).toBe(
			false,
		);
		expect(validate({ units: { a: { buildNumber: { offset: 1.5 } } } })).toBe(
			false,
		);
	});

	it("accepts dependency kinds on deps, bumps and unit keys, rejects unknown ones", () => {
		expect(
			validate({
				deps: [{ from: "a", to: "b", kind: "dev" }],
				bumps: { absorbedKinds: ["runtime"] },
				units: { "apps/*": { absorbedKinds: ["runtime", "peer", "dev"] } },
			}),
		).toBe(true);
		expect(validate({ deps: [{ from: "a", to: "b", kind: "build" }] })).toBe(
			false,
		);
		expect(validate({ bumps: { absorbedKinds: ["build"] } })).toBe(false);
		expect(validate({ units: { a: { absorbedKinds: ["build"] } } })).toBe(
			false,
		);
	});

	it("rejects version none and unknown keys", () => {
		expect(validate({ units: { a: { version: "none" } } })).toBe(false);
		expect(validate({ nope: 1 })).toBe(false);
	});
});
