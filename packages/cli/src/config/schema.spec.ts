import { Ajv } from "ajv";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { configJsonSchema, configSchema } from "./schema.js";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

const validate = new Ajv({ strict: false }).compile(configJsonSchema());

// Examples from design.md A.10 without v0.3 keys.
const examples = [
	...read("../../../../docs/design.md").matchAll(/```yaml\n([\s\S]*?)```/g),
]
	.map((m) => m[1]!.split("# v0.3")[0]!)
	.filter((y) => y.startsWith("# "));

describe("configJsonSchema", () => {
	it("finds the design examples", () => {
		expect(examples.length).toBeGreaterThan(0);
	});

	it("accepts the repo config and an empty config", () => {
		expect(validate({})).toBe(true);
		expect(validate(parse(read("../../../../tallyrelease.yaml")))).toBe(true);
	});

	it.each(examples)("accepts design example %#", (yaml) => {
		expect(validate(parse(yaml))).toBe(true);
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

	it("rejects version none and unknown keys", () => {
		expect(validate({ units: { a: { version: "none" } } })).toBe(false);
		expect(validate({ nope: 1 })).toBe(false);
	});
});
