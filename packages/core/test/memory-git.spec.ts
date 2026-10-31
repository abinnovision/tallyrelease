import { expect, it } from "vitest";

import { gitReaderConformance } from "../src/testing/conformance.js";
import { memoryGit } from "../src/testing/index.js";

gitReaderConformance((dag) => ({ git: memoryGit(dag), sha: (id) => id }));

it("lists the parents of a ref", () => {
	const git = memoryGit({
		commits: [{ id: "a" }, { id: "b" }, { id: "m", parents: ["a", "b"] }],
		tags: [{ name: "t", commit: "m" }],
	});
	expect([git.parents("t"), git.parents("HEAD"), git.parents("a")]).toEqual([
		["a", "b"],
		["a", "b"],
		[],
	]);
});
