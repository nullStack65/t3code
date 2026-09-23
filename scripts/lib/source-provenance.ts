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
export const UNKNOWN_PROVENANCE = "unknown";

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SHORT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;

export interface BuildInfo {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly sourceSha: string;
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
  for (const candidate of [env[SOURCE_SHA_ENV], env.GITHUB_SHA, gitSha]) {
    const trimmed = candidate?.trim();
    if (trimmed !== undefined && SHORT_SHA_PATTERN.test(trimmed)) {
      return trimmed.toLowerCase();
    }
  }
  return UNKNOWN_PROVENANCE;
}

export function createBuildInfo(input: BuildInfoInput): BuildInfo {
  return {
    schemaVersion: 1,
    repository: input.repository ?? UNKNOWN_PROVENANCE,
    sourceSha: input.sourceSha ?? UNKNOWN_PROVENANCE,
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
