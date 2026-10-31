import { defineCodes } from "@tallyrelease/core";

/**
 * Codes raised by cli. Codes are only added, never removed or renamed.
 */
export const cliCodes = defineCodes({
	E_BASE_REQUIRED: {
		cause:
			"`tallyrelease run` could not determine the build base because the request for the last successful run failed (`W_FORGE_ERROR`). Planning without a base would use the wrong range, so `run` stops before tagging or pushing anything.",
		fix: "Re-run once the forge is reachable, or pass `--base <ref>` explicitly. Check that the token (`--token` or `GITHUB_TOKEN`) is valid.",
	},
	E_BASE_UNRESOLVED: {
		cause:
			"A base ref does not resolve to a commit, or the `pull_request` event has no merge base with HEAD. The ref comes from `--base`, `pull_request.base.sha` or `merge_group.base_sha` of the event payload.",
		fix: "Check the ref passed to `--base` and make sure it exists locally (`git fetch origin <ref>`). In CI, check out the full history with `fetch-depth: 0`.",
	},
	E_CONFIG_MISSING: {
		cause:
			"The config file does not exist at the path given by `--config` (default `tallyrelease.yaml`) in the repository root.",
		fix: "Create `tallyrelease.yaml`, for example with `plugins: { node: {} }`, or pass the right path with `--config`.",
	},
	E_CWD_MISSING: {
		cause:
			"The directory given by `--cwd` (or the current directory) does not exist.",
		fix: "Pass an existing repository root with `--cwd`, or run the command from it.",
	},
	E_GITHUB_EVENT: {
		cause:
			"`GITHUB_EVENT_PATH` is set but the file cannot be read or parsed as JSON.",
		fix: "Check that `GITHUB_EVENT_PATH` points to the event payload file of the GitHub Actions run, or unset it when running locally.",
	},
	E_GITHUB_OUTPUT: {
		cause:
			"`--github-output` was passed but `GITHUB_OUTPUT` is not set. For `plan` and `run`, it is also raised when neither `--out` nor `RUNNER_TEMP` is available.",
		fix: "Run inside GitHub Actions, or set `GITHUB_OUTPUT` to a writable file. For `plan` and `run`, also pass `--out <file>`.",
	},
	E_GIT_READ: {
		cause:
			"A git read of a file at a ref failed, for example when `git cat-file` cannot find the blob or the ref. The message includes git's reason.",
		fix: "Check that the ref and path exist (`git cat-file -e <ref>:<path>`). In CI, fetch enough history with `fetch-depth: 0`.",
	},
	E_HEAD_UNRESOLVED: {
		cause:
			"The ref given by `--head` (or `HEAD` for `shadow`) does not resolve to a commit.",
		fix: "Pass an existing commit to `--head`, and fetch it first if it is not available locally.",
	},
	E_INTERNAL: {
		cause:
			"An unexpected error that tallyrelease did not classify, such as a failed git push, a filesystem error or a bug.",
		fix: "Re-run with `--verbose` to see the stack and cause. If it is not a local problem, report it with that output.",
	},
	E_NOT_A_REPO: {
		cause: "The working directory is not inside a git repository.",
		fix: "Run the command from a git checkout, or pass the repository root with `--cwd`.",
	},
	E_NOT_REPO_ROOT: {
		cause: "The working directory is below the repository root.",
		fix: "Run the command from the repository root, or pass it with `--cwd`.",
	},
	E_NO_FORGE: {
		cause:
			"`pr` or `release` has no forge token, or the forge repository cannot be determined from `GITHUB_REPOSITORY` or the `origin` remote.",
		fix: "Pass `--token` or set `GITHUB_TOKEN`, and set `GITHUB_REPOSITORY` (`owner/repo`) or add an `origin` remote with a GitHub URL.",
	},
	E_NO_HEAD: {
		cause:
			"`HEAD` does not resolve to a commit because the repository has no commits.",
		fix: "Create an initial commit before running the command.",
	},
	E_PATH_OUTSIDE_ROOT: {
		cause:
			"A file to write, such as a version file, is the repository root itself or resolves outside it.",
		fix: "Use repo-relative paths without `..` for version files, in the config and in plugin options.",
	},
	E_PENDING_RECONCILE: {
		cause:
			"`pr` found merged release PRs that have not been tagged yet, so opening a new release PR would use stale state.",
		fix: "Run `tallyrelease release` first to tag and publish the merged release PRs, then run `pr` again.",
	},
	E_PLUGIN_LOAD: {
		cause:
			"A plugin set with `plugins.<name>.path` could not be loaded: the file is missing, outside the repository, fails to import, does not export a plugin, or exports a plugin with another name. A built-in plugin (`node`, `php`, `kustomize`) that sets `path` is also rejected, since built-ins cannot be replaced.",
		fix: "Check the path (relative to the repository root) and that the file's default export is a plugin whose `name` is the config key. Remove `path` from built-in plugins, or use another name.",
	},
	E_PUSH_LEASE: {
		cause:
			"A push was rejected because a remote ref moved since tallyrelease read it, usually a concurrent run or a commit pushed to the release branch.",
		fix: "Re-run the command so it reads the current remote state. Avoid running concurrent jobs for the same branch.",
	},
	E_SHADOW_INPUT: {
		cause:
			"The release-please manifest (`--manifest`) or config (`--rp-config`) read by `shadow` is not valid JSON, or is not an object (of version strings for the manifest).",
		fix: "Fix the JSON in the file named in the message.",
	},
	E_SHADOW_MISMATCH: {
		cause:
			"`shadow --strict` found rows of the comparison between the plan and the release-please manifest change that are not labelled as expected differences.",
		fix: "Inspect the report (`--out` or `--summary`) and resolve or label the differing rows, or run without `--strict`.",
	},
	E_SHALLOW_BASE: {
		cause:
			"A base commit is missing from a shallow clone, or has no common history with HEAD in it.",
		fix: "Fetch the full history, for example `fetch-depth: 0` in `actions/checkout` or `git fetch --unshallow`.",
	},
	E_TAG_EXISTS: {
		cause:
			"A release tag already exists at a different commit, locally or on the remote. With `--dry-run` this is detected without writing.",
		fix: "Check whether the release was already tagged by another commit. Delete or move the stale tag only if it is wrong (`git tag -d <tag>` and `git push origin :refs/tags/<tag>`), then re-run.",
	},
	W_EFFECT_SKIPPED: {
		cause:
			"An effect command (`version`, `pr` or `release`) did nothing because it ran on a `pull_request` or `merge_group` event, or on a branch with no matching `branches` rule.",
		fix: "Run the command on a push to a branch matched by a `branches` rule, or add a rule for the branch.",
	},
	W_FORGE_ERROR: {
		cause:
			"A forge request failed. Either the last successful workflow run could not be read (the build base is unknown), or the PRs and releases of released commits could not be read for `plan`.",
		fix: "Check the token (`--token` or `GITHUB_TOKEN`), its permissions and the forge status, or pass `--base <ref>`.",
	},
	W_HEAD_BRANCH: {
		cause:
			"`--head` was used without `--branch`, so the plan uses the branch rule for the current branch instead of the branch the commit belonged to.",
		fix: "Pass `--branch <name>` to choose the branch rule.",
	},
	W_NO_FORGE: {
		cause:
			"There is no forge token, so the last successful run cannot be read and the base falls back to what is available locally.",
		fix: "Pass `--token` or set `GITHUB_TOKEN`, or pass `--base <ref>`.",
	},
	W_NO_LAST_SUCCESS: {
		cause:
			"The forge has no successful push run of this workflow on this branch that is an ancestor of HEAD, so there is no base.",
		fix: "Expected on the first run. Otherwise, check that the workflow succeeded on this branch before, or pass `--base <ref>`.",
	},
	W_NO_WORKFLOW_CONTEXT: {
		cause:
			"`GITHUB_REPOSITORY`, `GITHUB_WORKFLOW_REF` or `GITHUB_REF_NAME` is missing, so the last successful run cannot be looked up.",
		fix: "Run inside GitHub Actions, or pass `--base <ref>`.",
	},
	W_PR_HEAD_BEHIND: {
		cause:
			"HEAD is not the tip of the base branch on the forge, so `pr` leaves the release PRs unchanged.",
		fix: "Run `pr` on the latest commit of the branch, for example in the workflow triggered by the newest push.",
	},
	W_SHADOW_INPUT_MISSING: {
		cause:
			"A file passed to `shadow` with `--manifest` or `--rp-config` does not exist at the compared commit.",
		fix: "Correct the path, or omit the flag to use the default file name.",
	},
	W_SHADOW_SKIPPED: {
		cause:
			"`shadow` skipped the comparison, either because the manifest did not change in the compared commit or because a maintenance limit (`E_CAP` or `E_CAP_BASE`) applies. The message gives the reason.",
		fix: "Nothing to do for a commit that did not touch the manifest. For a limit, see `E_CAP` or `E_CAP_BASE`.",
	},
	W_TAG_UNKNOWN: {
		cause: "A `--tag` value of `affected` is not a label on any unit.",
		fix: "Correct the value, or add the label to `units.<root>.tags`.",
	},
});
