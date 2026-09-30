#!/usr/bin/env node
/**
 * Build provenance embedded into packaged output.
 *
 * A fork build has to be distinguishable from an upstream build from the bytes
 * alone: a release is only trustworthy if the desktop app, the bundled server,
 * and the WSL runtime archive all name the same repository, full source SHA,
 * version, and architecture. This module resolves those values once and both
 * packaging scripts write them the same way.
 *
 * Resolution order for the repository and SHA is: an explicit
 * `T3CODE_SOURCE_REPOSITORY`/`T3CODE_SOURCE_SHA`, then the GitHub Actions
 * variables, then the local git checkout, then `unknown`. The full 40-character
 * SHA is preferred; a short SHA is accepted from git only as a fallback.
 *
 * In a release build (`T3CODE_RELEASE_BUILD=1`) the rules tighten: the source
 * SHA must be the full SHA of the actual checkout, an explicit `T3CODE_SOURCE_SHA`
 * that disagrees with the checkout is a hard failure, and `GITHUB_SHA` (the
 * workflow-dispatch revision) is never used as source provenance — it is
 * recorded separately as `workflowRevision`. A manually dispatched workflow can
 * therefore build an older selected SHA without labelling the payload with the
 * dispatch commit.
 */
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { CLI_RELEASE_REPOSITORY } from "@t3tools/shared/cliRelease";

export const BUILD_INFO_FILE_NAME = "t3code-build-info.json";
export const SOURCE_REPOSITORY_ENV = "T3CODE_SOURCE_REPOSITORY";
export const SOURCE_SHA_ENV = "T3CODE_SOURCE_SHA";
export const WORKFLOW_SHA_ENV = "GITHUB_SHA";
export const RELEASE_BUILD_ENV = "T3CODE_RELEASE_BUILD";
export const UNKNOWN_PROVENANCE = "unknown";

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SHORT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;

export interface BuildInfo {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly sourceSha: string;
  readonly workflowRevision: string;
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly channel: string;
}

export interface BuildInfoInput {
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly repository?: string | undefined;
  readonly sourceSha?: string | undefined;
  readonly workflowRevision?: string | undefined;
}

/** The release train a fork version belongs to. Fork releases are plain stable. */
export function resolveBuildChannel(version: string): string {
  const match = /-([a-z]+)\.\d{8}\.\d+$/.exec(version.trim());
  return match?.[1] ?? "stable";
}

/** Accepts `owner/repo`, a GitHub URL, or an ssh remote and returns `owner/repo`. */
export function parseSourceRepository(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  const sshMatch = /^git@[^:]+:(.+?)(?:\.git)?$/.exec(trimmed);
  const candidate = sshMatch?.[1] ?? trimmed;
  const withoutUrl = candidate
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^ssh:\/\/[^/]+\//, "")
    .replace(/\.git$/, "");
  return REPOSITORY_PATTERN.test(withoutUrl) ? withoutUrl : undefined;
}

/**
 * The repository a build is attributed to. An explicit override or the GitHub
 * Actions variable wins; otherwise this is the fork's own release repository.
 * A local git remote is deliberately not consulted: a fork worktree usually
 * names the upstream repo `origin`, and a fork build must never be labelled as
 * an upstream build.
 */
export function resolveSourceRepository(env: Readonly<Record<string, string | undefined>>): string {
  return (
    parseSourceRepository(env[SOURCE_REPOSITORY_ENV]) ??
    parseSourceRepository(env.GITHUB_REPOSITORY) ??
    CLI_RELEASE_REPOSITORY
  );
}

export function resolveSourceSha(
  env: Readonly<Record<string, string | undefined>>,
  gitSha?: string | undefined,
): string {
  for (const candidate of [env[SOURCE_SHA_ENV], env[WORKFLOW_SHA_ENV], gitSha]) {
    const trimmed = candidate?.trim();
    if (trimmed !== undefined && SHORT_SHA_PATTERN.test(trimmed)) {
      return trimmed.toLowerCase();
    }
  }
  return UNKNOWN_PROVENANCE;
}

export class SourceShaMismatchError extends Schema.TaggedError<SourceShaMismatchError>()(
  "SourceShaMismatchError",
  { declared: Schema.String, checkedOut: Schema.String },
) {
  override get message(): string {
    return `Declared source SHA ${this.declared} does not match the checked-out HEAD ${this.checkedOut}.`;
  }
}

export class UnknownSourceShaError extends Schema.TaggedError<UnknownSourceShaError>()(
  "UnknownSourceShaError",
  {},
) {
  override get message(): string {
    return "A release build requires a full source SHA, but neither T3CODE_SOURCE_SHA nor the git checkout provided one.";
  }
}

const isSourceShaMismatchError = Schema.is(SourceShaMismatchError);
const isUnknownSourceShaError = Schema.is(UnknownSourceShaError);

export function isReleaseBuild(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[RELEASE_BUILD_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

const fullSha = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim().toLowerCase();
  return trimmed !== undefined && FULL_SHA_PATTERN.test(trimmed) ? trimmed : undefined;
};

export interface SourceShaResolution {
  readonly sourceSha: string;
  /** `GITHUB_SHA` when it differs from the source; never the source itself. */
  readonly workflowRevision: string | undefined;
}

export interface SourceShaResolutionInput {
  readonly explicitSha?: string | undefined;
  readonly gitHead?: string | undefined;
  readonly workflowSha?: string | undefined;
  readonly releaseMode?: boolean;
}

/**
 * Resolves the source SHA that belongs in provenance.
 *
 * In release mode the actual source checkout is authoritative. An explicit
 * `T3CODE_SOURCE_SHA` that disagrees with the checkout is rejected instead of
 * silently winning, and `GITHUB_SHA` is only ever a separately recorded
 * workflow revision. Outside release mode the historical precedence is kept
 * (explicit, then GitHub Actions, then git).
 */
export function resolveBuildSourceSha(
  input: SourceShaResolutionInput,
): SourceShaResolution | SourceShaMismatchError | UnknownSourceShaError {
  const explicit = fullSha(input.explicitSha);
  const gitHead = fullSha(input.gitHead);
  const workflow = fullSha(input.workflowSha);

  if (input.releaseMode === true) {
    if (explicit !== undefined && gitHead !== undefined && explicit !== gitHead) {
      return new SourceShaMismatchError({ declared: explicit, checkedOut: gitHead });
    }
    const sourceSha = explicit ?? gitHead;
    if (sourceSha === undefined) {
      return new UnknownSourceShaError({});
    }
    return {
      sourceSha,
      workflowRevision: workflow !== undefined && workflow !== sourceSha ? workflow : undefined,
    };
  }

  const sourceSha = resolveSourceSha(
    {
      [SOURCE_SHA_ENV]: input.explicitSha,
      [WORKFLOW_SHA_ENV]: input.workflowSha,
    },
    input.gitHead,
  );
  return {
    sourceSha,
    workflowRevision: workflow !== undefined && workflow !== sourceSha ? workflow : undefined,
  };
}

/** Resolves provenance from the environment, failing closed in release mode. */
export const resolveBuildSourceShaFromEnv = Effect.fn("resolveBuildSourceShaFromEnv")(function* (
  env: Readonly<Record<string, string | undefined>>,
  gitHead?: string | undefined,
) {
  const resolution = resolveBuildSourceSha({
    explicitSha: env[SOURCE_SHA_ENV],
    gitHead,
    workflowSha: env[WORKFLOW_SHA_ENV],
    releaseMode: isReleaseBuild(env),
  });
  if (isSourceShaMismatchError(resolution) || isUnknownSourceShaError(resolution)) {
    return yield* resolution;
  }
  return resolution;
});

export function createBuildInfo(input: BuildInfoInput): BuildInfo {
  return {
    schemaVersion: 1,
    repository: input.repository ?? UNKNOWN_PROVENANCE,
    sourceSha: input.sourceSha ?? UNKNOWN_PROVENANCE,
    workflowRevision: input.workflowRevision ?? UNKNOWN_PROVENANCE,
    version: input.version,
    platform: input.platform,
    arch: input.arch,
    channel: resolveBuildChannel(input.version),
  };
}

const BuildInfoSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  repository: Schema.String,
  sourceSha: Schema.String,
  workflowRevision: Schema.String,
  version: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  channel: Schema.String,
});
const encodeBuildInfo = Schema.encodeEffect(Schema.fromJsonString(BuildInfoSchema));

/** The exact JSON text written into packaged output. */
export const serializeBuildInfo = (info: BuildInfo) => encodeBuildInfo(info);

/** Decodes the packaged `t3code-build-info.json` text back into typed provenance. */
export const parseBuildInfo = Schema.decodeUnknownSync(Schema.fromJsonString(BuildInfoSchema));

const collectStream = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runGit = Effect.fn("runGit")(function* (repoRoot: string, args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("git", [...args], { cwd: repoRoot, stdin: "ignore" }),
  );
  const [stdout, exitCode] = yield* Effect.all(
    [collectStream(child.stdout), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  ).pipe(Effect.orElseSucceed((): readonly [string, number] => ["", 1]));
  return exitCode === 0 ? stdout.trim() : "";
});

export interface GitSourceProvenance {
  readonly sourceSha: string;
}

/**
 * Reads the full HEAD SHA from a git checkout. Best effort: a shallow CI
 * checkout still answers `rev-parse HEAD`, and any failure yields an empty
 * string so the caller falls back to environment variables.
 */
export const readGitSourceProvenance = Effect.fn("readGitSourceProvenance")(function* (
  repoRoot: string,
) {
  const sourceSha = yield* runGit(repoRoot, ["rev-parse", "HEAD"]);
  return {
    sourceSha:
      FULL_SHA_PATTERN.test(sourceSha) || SHORT_SHA_PATTERN.test(sourceSha) ? sourceSha : "",
  } satisfies GitSourceProvenance;
});
