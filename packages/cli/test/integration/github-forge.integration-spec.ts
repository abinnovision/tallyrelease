import { createServer } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { memoryRepo } from "./harness/memory-repo.js";
import { actionsEnv, runCli } from "./harness/run-cli.js";
import { githubForge } from "../../src/forge/github.js";

import type { IncomingHttpHeaders, Server } from "node:http";

interface Request {
	/** Method and decoded path, for example `GET /repos/acme/repo/pulls/1`. */
	route: string;
	query: Record<string, string>;
	headers: IncomingHttpHeaders;
	body: unknown;
}

describe("github forge", () => {
	const repo = { owner: "acme", repo: "repo" };
	let requests: Request[] = [];
	/**
	 * Route (optionally with `?page=<n>`) to status, JSON body and extra
	 * headers; unlisted routes are 404.
	 */
	let routes: Record<string, [number, unknown, Record<string, string>?]> = {};
	let server: Server;
	let baseUrl = "";

	const routesOf = () => requests.map((r) => r.route);

	beforeAll(async () => {
		server = createServer((req, res) => {
			let raw = "";
			req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
			req.on("end", () => {
				const url = new URL(req.url ?? "", "http://localhost");
				const route = `${req.method ?? ""} ${decodeURIComponent(url.pathname)}`;
				requests.push({
					route,
					query: Object.fromEntries(url.searchParams),
					headers: req.headers,
					body: raw === "" ? undefined : JSON.parse(raw),
				});
				const page = url.searchParams.get("page");
				const [status, body, headers] = (page === null
					? undefined
					: routes[`${route}?page=${page}`]) ??
					routes[route] ?? [404, { message: "Not Found" }];
				res.writeHead(status, {
					"content-type": "application/json",
					...headers,
				});
				res.end(JSON.stringify(body));
			});
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		baseUrl = `http://127.0.0.1:${String(typeof address === "object" ? address?.port : "")}`;
	});

	beforeEach(() => {
		requests = [];
		routes = {};
	});

	afterAll(() => {
		server.close();
	});

	it("lists successful push runs via GITHUB_API_URL (G14)", async () => {
		routes = {
			"GET /repos/acme/repo/actions/workflows/ci.yaml/runs": [
				200,
				{
					total_count: 2,
					workflow_runs: [{ head_sha: "b" }, { head_sha: "a" }],
				},
			],
			"GET /repos/acme/repo/actions/workflows/broken.yaml/runs": [502, {}],
		};
		const forge = githubForge({ token: "secret", baseUrl });
		const query = { ...repo, workflow: "ci.yaml", branch: "main" };

		expect(await forge.lastSuccessfulPushRuns(query)).toEqual(["b", "a"]);
		expect(requests[0]?.query).toEqual({
			branch: "main",
			status: "success",
			event: "push",
			per_page: "100",
		});
		expect(requests[0]?.headers.authorization).toBe("token secret");

		expect(
			await forge.lastSuccessfulPushRuns({
				...query,
				workflow: "renamed.yaml",
			}),
		).toEqual([]);

		await expect(
			forge.lastSuccessfulPushRuns({ ...query, workflow: "broken.yaml" }),
		).rejects.toMatchObject({ status: 502 });
	});

	it("searches older pages of runs for a local ancestor", async () => {
		const runs = "GET /repos/acme/repo/actions/workflows/ci.yaml/runs";
		const page = (...shas: string[]) =>
			[200, { workflow_runs: shas.map((head_sha) => ({ head_sha })) }] as [
				number,
				unknown,
			];
		const affected = async () => {
			const result = await runCli(["affected", "--json"], {
				...memoryRepo({
					commits: [
						{ id: "p0", files: { "tallyrelease.yaml": "units: {}" } },
						{ id: "x", files: { a: "x" } },
						{ id: "p1", parents: ["p0"], files: { a: "1" } },
						{ id: "p2", files: { a: "2" } },
					],
				}),
				env: { ...actionsEnv, GITHUB_TOKEN: "t" },
				event: { name: "push", payload: { before: "0".repeat(40) } },
				forge: githubForge({ token: "t", baseUrl }),
			});
			const doc = JSON.parse(result.stdout) as {
				build: { base: string | null };
				warnings: { code: string }[];
			};

			return {
				base: doc.build.base,
				warnings: doc.warnings.map((w) => w.code),
				pages: requests.map((r) => r.query["page"]),
			};
		};

		// After a history rewrite: "x" is not an ancestor, "gone" no longer exists.
		routes = {
			[`${runs}?page=1`]: page("x", "gone"),
			[`${runs}?page=2`]: page("p1", "p0"),
		};
		expect(await affected()).toEqual({
			base: "p1",
			warnings: [],
			pages: ["1", "2"],
		});

		requests = [];
		routes = { [runs]: page("x") };
		expect(await affected()).toEqual({
			base: null,
			warnings: ["W_NO_LAST_SUCCESS"],
			pages: ["1", "2", "3", "4", "5"],
		});
	});

	describe("release effects (G38)", () => {
		const forge = () => githubForge({ token: "secret", baseUrl });
		const pull = (
			number: number,
			base: string,
			mergedAt: string | null = null,
			fullName = "acme/repo",
		) => ({
			number,
			html_url: `https://github.test/acme/repo/pull/${String(number)}`,
			head: {
				ref: `tallyrelease/release/${base}/shared`,
				sha: `h${String(number)}`,
				repo: { full_name: fullName },
			},
			base: { ref: base },
			body: `body ${String(number)}`,
			labels: [{ name: "tallyrelease: pending" }],
			merged_at: mergedAt,
			merge_commit_sha: `m${String(number)}`,
		});

		it("lists release PRs through the issues API", async () => {
			routes = {
				"GET /repos/acme/repo/issues": [
					200,
					[1, 2, 3, 4, 5, 6, 7].map((number) => ({
						number,
						...(number !== 3 && { pull_request: {} }),
					})),
				],
				"GET /repos/acme/repo/pulls/1": [200, pull(1, "main")],
				"GET /repos/acme/repo/pulls/2": [200, pull(2, "release/1.x")],
				"GET /repos/acme/repo/pulls/4": [
					200,
					pull(4, "main", "2026-01-02T00:00:00Z"),
				],
				"GET /repos/acme/repo/pulls/5": [
					200,
					pull(5, "main", "2026-01-01T00:00:00Z"),
				],
				"GET /repos/acme/repo/pulls/6": [200, pull(6, "main")],
				// From a fork: never a release PR.
				"GET /repos/acme/repo/pulls/7": [
					200,
					pull(7, "main", null, "fork/repo"),
				],
			};

			const open = await forge().releasePrs(repo, {
				base: "main",
				state: "open",
			});
			expect(requests[0]?.query).toEqual({
				labels: "tallyrelease: pending",
				state: "open",
				sort: "created",
				direction: "asc",
				per_page: "100",
			});
			expect(routesOf()).not.toContain("GET /repos/acme/repo/pulls/3");
			// The fake issues list ignores state; the adapter filters by merge.
			expect(open.map((p) => p.number)).toEqual([1, 4, 5, 6]);
			expect(open[0]).toEqual({
				number: 1,
				url: "https://github.test/acme/repo/pull/1",
				head: "tallyrelease/release/main/shared",
				headSha: "h1",
				base: "main",
				body: "body 1",
				labels: ["tallyrelease: pending"],
				mergedAt: null,
				mergeCommitSha: null,
			});

			requests = [];
			const merged = await forge().releasePrs(repo, {
				base: "main",
				state: "merged",
			});
			expect(requests[0]?.query["state"]).toBe("closed");
			expect(merged.map((p) => [p.number, p.mergeCommitSha])).toEqual([
				[5, "m5"],
				[4, "m4"],
			]);
		});

		it("follows pagination of the issues list", async () => {
			routes = {
				"GET /repos/acme/repo/issues": [
					200,
					[{ number: 1, pull_request: {} }],
					{
						link: `<${baseUrl}/repos/acme/repo/issues?labels=x&page=2>; rel="next", <${baseUrl}/repos/acme/repo/issues?labels=x&page=2>; rel="last"`,
					},
				],
				"GET /repos/acme/repo/issues?page=2": [
					200,
					[{ number: 2, pull_request: {} }],
				],
				"GET /repos/acme/repo/pulls/1": [200, pull(1, "main")],
				"GET /repos/acme/repo/pulls/2": [200, pull(2, "main")],
			};

			const open = await forge().releasePrs(repo, {
				base: "main",
				state: "open",
			});
			expect(open.map((p) => p.number)).toEqual([1, 2]);
			expect(routesOf()).toEqual([
				"GET /repos/acme/repo/issues",
				"GET /repos/acme/repo/issues",
				"GET /repos/acme/repo/pulls/1",
				"GET /repos/acme/repo/pulls/2",
			]);
		});

		it("finds the open PR of a head branch", async () => {
			routes = {
				"GET /repos/acme/repo/pulls": [200, [pull(3, "main")]],
			};
			const head = "tallyrelease/release/main/shared";

			expect(await forge().openPr(repo, { head, base: "main" })).toMatchObject({
				number: 3,
				head,
				headSha: "h3",
			});
			expect(requests[0]?.query).toEqual({
				head: `acme:${head}`,
				base: "main",
				state: "open",
			});

			routes = { "GET /repos/acme/repo/pulls": [200, []] };
			expect(
				await forge().openPr(repo, { head, base: "main" }),
			).toBeUndefined();
		});

		it("creates, updates and closes PRs", async () => {
			routes = {
				"POST /repos/acme/repo/pulls": [201, { number: 7 }],
				"PATCH /repos/acme/repo/pulls/7": [200, {}],
				"POST /repos/acme/repo/issues/7/comments": [201, {}],
			};
			const pr = {
				head: "tallyrelease/release/main/shared",
				base: "main",
				title: "chore(release): cli@1.0.0",
				body: "b",
			};

			expect(await forge().createPr(repo, pr)).toBe(7);
			await forge().updatePr(repo, 7, { body: "c" });
			await forge().closePr(repo, 7, "nothing to release");

			expect(requests.map((r) => [r.route, r.body])).toEqual([
				["POST /repos/acme/repo/pulls", pr],
				["PATCH /repos/acme/repo/pulls/7", { body: "c" }],
				[
					"POST /repos/acme/repo/issues/7/comments",
					{ body: "nothing to release" },
				],
				["PATCH /repos/acme/repo/pulls/7", { state: "closed" }],
				// Unrouted (404): the label is already gone, which is fine.
				[
					"DELETE /repos/acme/repo/issues/7/labels/tallyrelease: pending",
					undefined,
				],
			]);
		});

		it("sets a label, creating it when missing", async () => {
			routes = {
				"GET /repos/acme/repo/issues/7/labels": [
					200,
					[{ name: "tallyrelease: pending" }, { name: "bug" }],
				],
				"DELETE /repos/acme/repo/issues/7/labels/tallyrelease: pending": [
					200,
					[],
				],
				"POST /repos/acme/repo/labels": [201, {}],
				"POST /repos/acme/repo/issues/7/labels": [200, []],
				"POST /repos/acme/repo/issues/7/comments": [201, {}],
			};

			await forge().setLabel(repo, 7, {
				label: "tallyrelease: stale",
				comment: "plan changed",
			});

			expect(requests.map((r) => [r.route, r.body])).toEqual([
				["GET /repos/acme/repo/issues/7/labels", undefined],
				[
					"DELETE /repos/acme/repo/issues/7/labels/tallyrelease: pending",
					undefined,
				],
				["GET /repos/acme/repo/labels/tallyrelease: stale", undefined],
				[
					"POST /repos/acme/repo/labels",
					{ name: "tallyrelease: stale", color: "d93f0b" },
				],
				[
					"POST /repos/acme/repo/issues/7/labels",
					{ labels: ["tallyrelease: stale"] },
				],
				["POST /repos/acme/repo/issues/7/comments", { body: "plan changed" }],
			]);

			// Already labelled and no comment: read only.
			requests = [];
			routes["GET /repos/acme/repo/issues/7/labels"] = [
				200,
				[{ name: "tallyrelease: stale" }],
			];
			await forge().setLabel(repo, 7, { label: "tallyrelease: stale" });
			expect(routesOf()).toEqual(["GET /repos/acme/repo/issues/7/labels"]);
		});

		it("answers lookups and treats 404 as absent", async () => {
			routes = {
				"GET /repos/acme/repo/git/ref/heads/tallyrelease/release/main/shared": [
					200,
					{ object: { sha: "s1" } },
				],
				"GET /repos/acme/repo/commits/m9/pulls": [
					200,
					[
						{ number: 8, merge_commit_sha: "x", merged_at: null, labels: [] },
						{
							number: 9,
							html_url: "https://github.test/acme/repo/pull/9",
							merge_commit_sha: "m9",
							merged_at: "2026-01-01T00:00:00Z",
							labels: [{ name: "tallyrelease: released" }],
						},
					],
				],
				"GET /repos/acme/repo/commits/bad/pulls": [422, {}],
				"GET /repos/acme/repo/releases/tags/cli-v1.0.0": [
					200,
					{ id: 3, html_url: "https://example/r/3" },
				],
			};
			const f = forge();

			expect(await f.branchSha(repo, "tallyrelease/release/main/shared")).toBe(
				"s1",
			);
			expect(await f.branchSha(repo, "gone")).toBeUndefined();
			expect(await f.prForCommit(repo, "m9")).toEqual({
				number: 9,
				url: "https://github.test/acme/repo/pull/9",
				labels: ["tallyrelease: released"],
			});
			expect(await f.prForCommit(repo, "bad")).toBeUndefined();
			expect(await f.prForCommit(repo, "unknown")).toBeUndefined();
			expect(await f.releaseByTag(repo, "cli-v1.0.0")).toEqual({
				id: 3,
				url: "https://example/r/3",
			});
			expect(await f.releaseByTag(repo, "cli-v2.0.0")).toBeUndefined();

			routes["GET /repos/acme/repo/releases/tags/broken"] = [500, {}];
			await expect(f.releaseByTag(repo, "broken")).rejects.toMatchObject({
				status: 500,
			});
		});

		it("creates a release", async () => {
			routes = {
				"POST /repos/acme/repo/releases": [
					201,
					{ id: 4, html_url: "https://example/r/4" },
				],
			};

			expect(
				await forge().createRelease(repo, {
					tag: "cli-v1.0.1",
					name: "cli: v1.0.1",
					body: "notes",
					makeLatest: false,
				}),
			).toEqual({ id: 4, url: "https://example/r/4" });
			expect(requests[0]?.body).toEqual({
				tag_name: "cli-v1.0.1",
				name: "cli: v1.0.1",
				body: "notes",
				make_latest: "false",
			});
		});
	});
});
