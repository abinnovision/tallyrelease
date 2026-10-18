import { describe, expect, it } from "vitest";

import { gitEnv } from "./exec.js";

describe("gitEnv", () => {
	it("drops hook repository variables and keeps identity variables", () => {
		const env = {
			PATH: "/usr/bin",
			GIT_DIR: "/elsewhere",
			GIT_WORK_TREE: "/elsewhere",
			GIT_INDEX_FILE: "/elsewhere/index",
			GIT_AUTHOR_NAME: "A",
			GIT_COMMITTER_EMAIL: "c@example.com",
		};

		expect(gitEnv(env)).toEqual({
			PATH: "/usr/bin",
			GIT_AUTHOR_NAME: "A",
			GIT_COMMITTER_EMAIL: "c@example.com",
		});
		expect(gitEnv(env, { GIT_INDEX_FILE: "/tmp/index" })).toMatchObject({
			GIT_INDEX_FILE: "/tmp/index",
		});
	});
});
