import { memoryCtx } from "@tallyrelease/core/testing";
import { describe, expect, it } from "vitest";

import { moduleCalls, moduleCallsJson } from "./hcl.js";
import { terraformPlugin } from "./plugin.js";

import type { ModuleCall } from "./hcl.js";
import type { Unit } from "@tallyrelease/core";

const unit = (id: string, root: string, modules: ModuleCall[] = []): Unit => ({
	id,
	root,
	plugin: "terraform",
	include: [],
	exclude: [],
	version: "none",
	scheme: "semver",
	tagFormat: "",
	propagate: "auto",
	tags: [],
	initialVersion: null,
	meta: { terraform: { modules } },
});

describe("module calls", () => {
	it("reads literal sources of top-level module blocks", () => {
		const text = [
			'# module "commented" { source = "../no" }',
			'/* module "block" {',
			'  source = "../no" } */',
			'module "vpc" {',
			'  source = "../modules/vpc" // trailing',
			`  name   = "\${var.env}-vpc"`,
			"  tags = {",
			'    source = "nested"',
			"  }",
			"  policy = <<-EOT",
			'    module "inner" { source = "../no" }',
			"    EOT",
			"}",
			'module "remote" {',
			'  source  = "terraform-aws-modules/eks/aws"',
			'  version = "~> 20.0"',
			"}",
			`module "dynamic" { source = "\${path.module}/x" }`,
			'resource "null_resource" "x" { source = "../no" }',
			'module bare { source = "./bare" }',
			'module "escaped" { source = "\\u002e/no" }',
		].join("\n");

		expect(moduleCalls(text)).toEqual([
			{ name: "vpc", source: "../modules/vpc" },
			{ name: "remote", source: "terraform-aws-modules/eks/aws" },
			{ name: "bare", source: "./bare" },
		]);
	});

	it("reads module calls from JSON syntax", () => {
		const text = JSON.stringify({
			module: { db: { source: "./db" }, cache: [{ source: "../cache" }] },
			resource: { x: { source: "../no" } },
		});

		expect(moduleCallsJson(text)).toEqual([
			{ name: "db", source: "./db" },
			{ name: "cache", source: "../cache" },
		]);
	});
});

describe("terraform plugin", () => {
	it("discovers module directories as path ids, skipping .terraform caches", async () => {
		const files = {
			"infra/stacks/prod/main.tf": "",
			"infra/stacks/prod/.terraform/modules/vpc/main.tf": "",
			"infra/modules/vpc/main.tofu": "",
			"infra/modules/db/main.tf.json": "{}",
			"other/main.tf": "",
		};
		const discover = async (paths?: string[]) =>
			(
				await terraformPlugin.discover?.(
					memoryCtx({ files, options: paths ? { paths } : {} }),
				)
			)?.map((u) => [u.id, u.root]);

		expect(await discover()).toEqual([
			["infra-modules-db", "infra/modules/db"],
			["infra-modules-vpc", "infra/modules/vpc"],
			["infra-stacks-prod", "infra/stacks/prod"],
			["other", "other"],
		]);
		expect(await discover(["infra/**"])).toHaveLength(3);
	});

	it("keeps local unit sources, includes other local paths and warns on missing ones", async () => {
		const ctx = memoryCtx({
			files: {
				"infra/prod/main.tf": [
					'module "vpc" { source = "../modules/vpc" }',
					'module "eks" { source = "git::https://example.com/eks.git?ref=v1" }',
					'module "local" { source = "./local" }',
					'module "gone" { source = "../missing" }',
					'module "out" { source = "../../../outside" }',
				].join("\n"),
				"infra/prod/local/variables.tf": "",
				"infra/modules/vpc/main.tf": "",
			},
			options: { paths: ["infra/prod/**"] },
		});
		const draft = (await terraformPlugin.discover?.(ctx))?.find(
			(u) => u.root === "infra/prod",
		);

		expect(draft?.include).toEqual([
			"infra/prod/**",
			"infra/modules/vpc",
			"infra/modules/vpc/**",
		]);
		expect(draft?.meta).toEqual({
			modules: [{ name: "local", source: "./local" }],
		});
		expect(ctx.warnings).toEqual([
			'infra/prod: module "gone" source "../missing" does not exist',
			'infra/prod: module "out" source "../../../outside" leaves the repository',
		]);
	});

	it("creates edges from called modules to their callers", async () => {
		const vpc = unit("vpc", "modules/vpc");
		const net = unit("net", "modules/net", [{ name: "vpc", source: "../vpc" }]);
		const prod = unit("prod", "stacks/prod", [
			{ name: "net", source: "../../modules/net" },
			{ name: "gone", source: "../gone" },
		]);

		expect(
			await terraformPlugin.edges?.(memoryCtx(), [vpc, net, prod]),
		).toEqual([
			{
				from: "vpc",
				to: "net",
				reason: "module.vpc: ../vpc",
				pinned: false,
			},
			{
				from: "net",
				to: "prod",
				reason: "module.net: ../../modules/net",
				pinned: false,
			},
		]);
	});
});
