import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		name: "@internal/docs#unit",
		include: ["src/**/*.spec.ts"],
		environment: "node",
	},
});
