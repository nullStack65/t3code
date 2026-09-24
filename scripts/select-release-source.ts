#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Runs before dependencies are installed in a fresh CI job, so it must not import workspace/Effect packages.
/**
 * Selects and verifies the exact source commit a fork release builds.
 *
 * Run from the release workspace after the bootstrap fetch. It re-runs the
 * selection authoritatively: fetch the requested SHA and `main`, check out the
 * explicit SHA, assert `HEAD` equals it, and apply the requested ancestry
 * policy. Writes `sha`, `head_sha`, `workflow_sha`, and `mode` to
 * `GITHUB_OUTPUT` when available so a later job can bind provenance to the
 * actual checkout.
 *
 * `--mode public` (default) requires the SHA to be an ancestor of `main`.
 * `--mode candidate` accepts any commit reachable on the fork remote, which is
 * what lets a pre-merge PR head be built without faking main ancestry.
 *
 * This file intentionally uses only Node built-ins and plain `git` subprocesses:
 * it runs in a freshly bootstrapped job *before* `vp install`, so importing
 * `effect`/`@effect/platform-node` would fail to resolve.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DEFAULT_MAIN_REF = "main";

type ReleaseSourceMode = "public" | "candidate";

interface Args {
  repoUrl: string;
  sha: string;
  mainRef: string;
  cwd: string;
  mode: ReleaseSourceMode;
  githubOutput: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      flags.add(key);
    }
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value.trim() === "") throw new Error(`--${key} is required`);
    return value.trim();
  };
  const mode = values.get("mode")?.trim() || "public";
  if (mode !== "public" && mode !== "candidate") {
    throw new Error("--mode must be public or candidate");
  }
  return {
    repoUrl: required("repo-url"),
    sha: required("sha").toLowerCase(),
    mainRef: values.get("main-ref")?.trim() || DEFAULT_MAIN_REF,
    cwd: values.get("cwd")?.trim() || process.cwd(),
    mode,
    githubOutput: flags.has("github-output"),
  };
}

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function runGit(cwd: string, args: ReadonlyArray<string>): GitResult {
  const result = NodeChildProcess.spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    exitCode: result.status ?? 1,
  };
}

function runGitChecked(cwd: string, args: ReadonlyArray<string>): GitResult {
  const result = runGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${result.exitCode}: ${result.stderr}`);
  }
  return result;
}

/** Accepts `owner/repo`, a GitHub URL, or an ssh remote and returns `owner/repo`. */
export function repositoryFromUrl(url: string): string {
  return url
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^ssh:\/\/[^/]+\//, "")
    .replace(/^git@[^:]+:/, "")
    .replace(/\.git$/, "");
}

interface Selection {
  readonly sha: string;
  readonly headSha: string;
  readonly repository: string;
  readonly mode: ReleaseSourceMode;
  readonly ancestry: "on-main" | "on-fork";
}

export function selectReleaseSource(input: Args): Selection {
  const sha = input.sha;
  if (!FULL_SHA_PATTERN.test(sha)) {
    throw new Error(`Release source SHA '${input.sha}' is not a full 40-character hex commit.`);
  }
  const cwd = input.cwd;

  runGit(cwd, ["init", "."]);
  const add = runGit(cwd, ["remote", "add", "origin", input.repoUrl]);
  if (add.exitCode !== 0) {
    runGitChecked(cwd, ["remote", "set-url", "origin", input.repoUrl]);
  }

  runGitChecked(cwd, ["fetch", "--no-tags", "--depth=1", "origin", sha]);
  runGitChecked(cwd, ["fetch", "--no-tags", "origin", input.mainRef]);

  // Check out the validated SHA itself, never `FETCH_HEAD`.
  runGitChecked(cwd, ["checkout", "--detach", sha]);

  const headSha = runGitChecked(cwd, ["rev-parse", "HEAD"]).stdout.toLowerCase();
  if (headSha !== sha) {
    throw new Error(`Checked out HEAD ${headSha} does not match the requested source ${sha}.`);
  }

  const onMain =
    runGit(cwd, ["merge-base", "--is-ancestor", sha, `origin/${input.mainRef}`]).exitCode === 0;

  if (input.mode === "public" && !onMain) {
    throw new Error(`Release source ${sha} is not an ancestor of origin/${input.mainRef}.`);
  }
  if (input.mode === "candidate" && !onMain) {
    const exists = runGit(cwd, ["cat-file", "-e", `${sha}^{commit}`]);
    if (exists.exitCode !== 0) {
      throw new Error(`Candidate source ${sha} is not a commit on the fork remote.`);
    }
  }

  return {
    sha,
    headSha,
    repository: repositoryFromUrl(input.repoUrl),
    mode: input.mode,
    ancestry: onMain ? "on-main" : "on-fork",
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const selected = selectReleaseSource(args);
  console.log(
    `Selected source ${selected.sha} (HEAD ${selected.headSha}, mode ${selected.mode}, ancestry ${selected.ancestry}, repo ${selected.repository})`,
  );
  const workflowSha = process.env.GITHUB_SHA?.trim() ?? "";
  if (workflowSha !== "" && workflowSha.toLowerCase() !== selected.sha) {
    console.log(
      `Workflow revision ${workflowSha} differs from the selected source; it is recorded separately, not as source provenance.`,
    );
  }
  if (args.githubOutput) {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (outputPath === undefined || outputPath.trim() === "") {
      throw new Error("--github-output requires GITHUB_OUTPUT");
    }
    NodeFS.appendFileSync(
      outputPath,
      [
        `sha=${selected.sha}`,
        `head_sha=${selected.headSha}`,
        `workflow_sha=${workflowSha}`,
        `source_mode=${selected.mode}`,
        `source_ancestry=${selected.ancestry}`,
        "",
      ].join("\n"),
    );
  }
}

main();
