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
}

export interface SelectReleaseSourceInput {
  readonly cwd: string;
  readonly repoUrl: string;
  readonly sha: string;
  readonly mainRef?: string;
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
 * ancestry. The explicit SHA is the only checkout target, so a later fetch of
 * `main` cannot change what was selected.
 */
export const selectReleaseSource = Effect.fn("selectReleaseSource")(function* (
  input: SelectReleaseSourceInput,
) {
  const sha = normalizeSourceSha(input.sha);
  if (sha === undefined) {
    return yield* new InvalidSourceShaError({ sha: input.sha });
  }
  const mainRef = input.mainRef?.trim() || DEFAULT_MAIN_REF;

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
  if (ancestor.exitCode !== 0) {
    return yield* new SourceNotOnMainError({ sha, mainRef });
  }

  return {
    sha,
    mainRef,
    headSha,
    repository: input.repository?.trim() || repositoryFromUrl(input.repoUrl),
  } satisfies ReleaseSourceSelection;
});
