import {
	base,
	configFiles,
	stylistic,
	vitest,
} from "@abinnovision/eslint-config-base";
import { defineConfig, globalIgnores } from "eslint/config";

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
	globalIgnores(["**/*.generated.ts", "**/*.gen.ts", "dist"]),
]);
