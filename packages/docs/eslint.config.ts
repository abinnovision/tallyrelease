import {
	base,
	configFiles,
	stylistic,
	vitest,
} from "@abinnovision/eslint-config-base";
import { defineConfig } from "eslint/config";

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
	{
		// Private tooling: every dependency is a devDependency.
		rules: {
			"import/no-extraneous-dependencies": ["error", { devDependencies: true }],
		},
	},
	{ files: ["*.{c,m,}{t,j}s"], extends: [configFiles] },
]);
