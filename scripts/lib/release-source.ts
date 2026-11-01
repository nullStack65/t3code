#!/usr/bin/env node
/**
 * Exact source selection for a fork release.
 *
 * A release must build the commit the operator named, not "whatever `FETCH_HEAD`
 * happens to point at" after a second fetch. The previous sequence fetched the
 * requested SHA, then fetched `main`, then checked out `FETCH_HEAD`: the second
 * fetch overwrote `FETCH_HEAD`, so the build silently ran on `main` instead of
 * the selected (possibly older) SHA.
 *
 * This module validates the requested full SHA, fetches the refs it needs,
 * checks out that explicit SHA, asserts the actual `HEAD` equals it, and checks
 * ancestry against `origin/<main>` separately. Ancestry is a policy check (the
 * SHA must already be on `main`); it is never the checkout target.
 */
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const FULL_SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const DEFAULT_MAIN_REF = "main";

/**
 * Why a source SHA is allowed to be built.
 *
 * - `public`: the SHA must already be an ancestor of the fork's `main`. This is
 *   the policy a *published* fork release requires, so a candidate built from a
 *   PR branch can never be promoted under the public policy later without a
 *   fresh, verified checkout of the approved main-line source.
 * - `candidate`: the SHA only has to be a real commit on an explicitly resolved
 *   fork remote. It exists so a pre-merge PR head (which is not on `main`) can
 *   still be built and exercised locally. It never substitutes for the public
 *   policy and never claims main ancestry the commit does not have.
 */
export type ReleaseSourceMode = "public" | "candidate";

export class SourceNotOnForkError extends Schema.TaggedError<SourceNotOnForkError>()(
  "SourceNotOnForkError",
  { sha: Schema.String, forkRemote: Schema.String },
) {
  override get message(): string {
    return `Candidate source ${this.sha} is not a commit on the writable fork remote '${this.forkRemote}'.`;
  }
}

export class InvalidSourceShaError extends Schema.TaggedError<InvalidSourceShaError>()(
  "InvalidSourceShaError",
  { sha: Schema.String },
) {
  override get message(): string {
    return `Release source SHA '${this.sha}' is not a full 40-character hex commit.`;
  }
}

export class SourceCheckoutMismatchError extends Schema.TaggedError<SourceCheckoutMismatchError>()(
  "SourceCheckoutMismatchError",
  { requested: Schema.String, actual: Schema.String },
) {
  override get message(): string {
    return `Checked out HEAD ${this.actual} does not match the requested source ${this.requested}.`;
  }
}

export class SourceNotOnMainError extends Schema.TaggedError<SourceNotOnMainError>()(
  "SourceNotOnMainError",
  { sha: Schema.String, mainRef: Schema.String },
) {
  override get message(): string {
    return `Release source ${this.sha} is not an ancestor of origin/${this.mainRef}.`;
  }
}

export class GitCommandError extends Schema.TaggedError<GitCommandError>()("GitCommandError", {
  args: Schema.Array(Schema.String),
  exitCode: Schema.Number,
  stderr: Schema.String,
}) {
  override get message(): string {
    return `git ${this.args.join(" ")} exited ${this.exitCode}: ${this.stderr.trim()}`;
  }
}

/** Accepts only a full 40-character hex SHA; everything else is `undefined`. */
export function normalizeSourceSha(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed !== undefined && FULL_SOURCE_SHA_PATTERN.test(trimmed) ? trimmed : undefined;
}

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const collectStream = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runGit = Effect.fn("runGit")(function* (cwd: string, args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make("git", [...args], { cwd, stdin: "ignore" }));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStream(child.stdout),
      collectStream(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.orElseSucceed((): readonly [string, string, number] => ["", "", 1]));
  return { stdout, stderr, exitCode } satisfies GitResult;
});

const runGitChecked = Effect.fn("runGitChecked")(function* (cwd: string, args: readonly string[]) {
  const result = yield* runGit(cwd, args);
  if (result.exitCode !== 0) {
    return yield* new GitCommandError({
      args: [...args],
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
  return result;
});

export interface ReleaseSourceSelection {
  readonly sha: string;
  readonly mainRef: string;
  readonly headSha: string;
  readonly repository: string;
  readonly mode: ReleaseSourceMode;
  /** The ancestry policy actually applied, for the receipt/log. */
  readonly ancestry: "on-main" | "on-fork";
}

export interface SelectReleaseSourceInput {
  readonly cwd: string;
  /**
   * The writable fork remote URL to fetch the source from. It is resolved
   * explicitly by the caller rather than assumed to be `origin`: the Windows
   * checkout names upstream `origin` and the fork `fork`.
   */
  readonly repoUrl: string;
  readonly sha: string;
  readonly mainRef?: string;
  /**
   * `public` (default) requires ancestry on `main`; `candidate` accepts any
   * commit reachable on the fork remote so a pre-merge PR head can be built.
   */
  readonly mode?: ReleaseSourceMode;
  /** `owner/repo`, recorded for provenance output. Defaults to the URL's path. */
  readonly repository?: string;
}

const repositoryFromUrl = (url: string): string =>
  url
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^ssh:\/\/[^/]+\//, "")
    .replace(/^git@[^:]+:/, "")
    .replace(/\.git$/, "");

/**
 * Fetches and checks out exactly `input.sha`, then asserts the checkout and the
 * ancestry policy for the requested mode. The explicit SHA is the only checkout
 * target, so a later fetch of `main` cannot change what was selected.
 *
 * `public` mode additionally requires the SHA to be an ancestor of
 * `origin/<main>`. `candidate` mode instead requires the SHA to be reachable on
 * the fork remote; it never fabricates main ancestry.
 */
export const selectReleaseSource = Effect.fn("selectReleaseSource")(function* (
  input: SelectReleaseSourceInput,
) {
  const sha = normalizeSourceSha(input.sha);
  if (sha === undefined) {
    return yield* new InvalidSourceShaError({ sha: input.sha });
  }
  const mainRef = input.mainRef?.trim() || DEFAULT_MAIN_REF;
  const mode: ReleaseSourceMode = input.mode === "candidate" ? "candidate" : "public";

  yield* runGit(input.cwd, ["init", "."]);
  const add = yield* runGit(input.cwd, ["remote", "add", "origin", input.repoUrl]);
  if (add.exitCode !== 0) {
    yield* runGitChecked(input.cwd, ["remote", "set-url", "origin", input.repoUrl]);
  }

  yield* runGitChecked(input.cwd, ["fetch", "--no-tags", "--depth=1", "origin", sha]);
  yield* runGitChecked(input.cwd, ["fetch", "--no-tags", "origin", mainRef]);
  yield* runGitChecked(input.cwd, ["sparse-checkout", "set", "--no-cone", "/*", "!/.repos/"]);

  // Check out the validated SHA itself, never `FETCH_HEAD`.
  yield* runGitChecked(input.cwd, ["checkout", "--detach", sha]);

  const head = yield* runGitChecked(input.cwd, ["rev-parse", "HEAD"]);
  const headSha = head.stdout.trim().toLowerCase();
  if (headSha !== sha) {
    return yield* new SourceCheckoutMismatchError({ requested: sha, actual: headSha });
  }

  const ancestor = yield* runGit(input.cwd, [
    "merge-base",
    "--is-ancestor",
    sha,
    `origin/${mainRef}`,
  ]);
  if (mode === "public") {
    if (ancestor.exitCode !== 0) {
      return yield* new SourceNotOnMainError({ sha, mainRef });
    }
    return {
      sha,
      mainRef,
      headSha,
      repository: input.repository?.trim() || repositoryFromUrl(input.repoUrl),
      mode,
      ancestry: "on-main",
    } satisfies ReleaseSourceSelection;
  }

  // Candidate mode: the commit must at least exist on the fork remote, so a
  // typo or a SHA from an unrelated repository is still rejected. Reachability,
  // not main ancestry, is the check. It is deliberately not required to be on
  // `main`; the reported ancestry records the truth either way.
  const onMain = ancestor.exitCode === 0;
  if (!onMain) {
    const exists = yield* runGit(input.cwd, ["cat-file", "-e", `${sha}^{commit}`]);
    if (exists.exitCode !== 0) {
      return yield* new SourceNotOnForkError({ sha, forkRemote: "origin" });
    }
  }

  return {
    sha,
    mainRef,
    headSha,
    repository: input.repository?.trim() || repositoryFromUrl(input.repoUrl),
    mode,
    ancestry: onMain ? "on-main" : "on-fork",
  } satisfies ReleaseSourceSelection;
});
