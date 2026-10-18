import { gitReaderConformance } from "@tallyrelease/core/testing/conformance";
import { afterAll } from "vitest";

import { createRepo, removeTmpDirs } from "./harness/git-repo.js";
import { gitReader } from "../../src/git/reader.js";

afterAll(removeTmpDirs);

// G16: the real reader passes the shared GitReader spec.
gitReaderConformance((dag) => {
	const repo = createRepo(dag);

	return { git: gitReader(repo.dir), sha: repo.sha };
});
