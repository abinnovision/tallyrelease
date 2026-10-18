import {
	base,
	configFiles,
	stylistic,
	vitest,
} from "@abinnovision/eslint-config-base";
import { defineConfig, globalIgnores } from "eslint/config";
import { builtinModules } from "node:module";

import type { Linter } from "eslint";

const nodeBuiltins = `^(node:)?(${[
	...new Set(builtinModules.map((m) => m.replace(/^node:/, ""))),
].join("|")})(/.*)?$`;
const impureGlobals = ["process", "fetch", "require", "Buffer"];
const codeLiterals = (error: string, warning: string) => [
	{
		selector:
			"NewExpression[callee.name='TallyError'][arguments.0.type='Literal']",
		message: error,
	},
	{
		selector:
			"NewExpression[callee.name='TallyError'][arguments.0.type='TemplateLiteral']",
		message: error,
	},
	{
		selector:
			"Property[key.name='code'][value.type='Literal'][value.value=/^W_/]",
		message: warning,
	},
];
const pluginPurity: Linter.RulesRecord = {
	"no-restricted-globals": ["error", ...impureGlobals],
	"no-restricted-properties": [
		"error",
		...impureGlobals.map((property) => ({ object: "globalThis", property })),
	],
	"no-restricted-syntax": [
		"error",
		{
			selector: "ImportExpression",
			message: "plugins use Ctx only: no dynamic imports.",
		},
		...codeLiterals(
			"use coreCodes or a defineCodes registry: .error()",
			"use coreCodes or a defineCodes registry: .warning()",
		),
	],
};

export default defineConfig([
	{
		extends: [base, vitest, stylistic],
		languageOptions: {
			parserOptions: {
				project: "./tsconfig.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{ files: ["*.{c,m,}{t,j}s"], extends: [configFiles] },
	{
		files: ["src/**/*.ts"],
		ignores: ["src/**/*.spec.ts"],
		rules: {
			"no-restricted-syntax": [
				"error",
				...codeLiterals(
					"raise registered codes via cliCodes.error()",
					"raise registered codes via cliCodes.warning()",
				),
			],
		},
	},
	{
		files: ["src/plugins/*.ts"],
		ignores: ["src/plugins/**/*.spec.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							regex: nodeBuiltins,
							message: "plugins use Ctx only (public API).",
						},
						{
							regex: "^\\.\\./",
							message:
								"plugins import only @tallyrelease/core and src/plugins/**.",
						},
					],
				},
			],
			...pluginPurity,
		},
	},
	{
		files: ["src/plugins/*/**/*.ts"],
		ignores: ["src/plugins/**/*.spec.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							regex: nodeBuiltins,
							message: "plugins use Ctx only (public API).",
						},
						{
							regex: "^\\.\\./\\.\\./",
							message:
								"plugins import only @tallyrelease/core and src/plugins/**.",
						},
					],
				},
			],
			...pluginPurity,
		},
	},
	globalIgnores(["**/*.generated.ts", "**/*.gen.ts", "dist"]),
]);
