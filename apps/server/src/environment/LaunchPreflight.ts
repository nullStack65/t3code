import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { compareSemverVersions } from "@t3tools/shared/semver";
import type { VcsError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";

/**
 * Automatic launch preflight for the server's shared session root.
 *
 * The root is `ServerConfig.cwd`: the directory provider sessions default to and
 * the directory auto-bootstrap roots a project at. Before sessions start, this
 * checks the environment the harness actually depends on:
 *
 * - the `git` executable on the launch PATH supports the flags T3 uses;
 * - an accidental umbrella repository at the shared root is flagged, because
 *   every project beneath it would then share one repository and T3 checkpoints
 *   could be written into it;
 * - one small, relevant file at the root is read to detect a stalled or
 *   cloud-offloaded filesystem without scanning the tree.
 *
 * Every probe is bounded. The preflight only warns; it never mutates Git
 * metadata, disables sync, kills processes, or calls a model.
 */

/**
 * `GitVcsDriver` runs `git rev-parse --path-format=absolute --git-path index`,
 * which needs Git 2.31.0 or newer. Apple's `/usr/bin/git` on this machine is
 * 2.24.3, so the check is not theoretical.
 */
export const MINIMUM_GIT_VERSION = "2.31.0";

const GIT_PROBE_TIMEOUT = "3 seconds";
const EXISTS_PROBE_TIMEOUT = "1 second";
const ROOT_LIST_TIMEOUT = "1 second";
const READ_PROBE_TIMEOUT = "1 second";
const READ_PROBE_MAX_BYTES = 32 * 1024;
const MAX_ROOT_CHILDREN = 64;
const GIT_VERSION_PATTERN = /\b(\d+\.\d+\.\d+)\b/;

/** Files probed, in order, for the bounded root read. All are small and relevant. */
const READ_PROBE_CANDIDATES = ["AGENTS.md", "package.json", "README.md", ".git/HEAD"] as const;

export type LaunchPreflightWarningCode =
  | "git-startup-failed"
  | "git-probe-timed-out"
  | "git-too-old"
  | "git-probe-failed"
  | "shared-root-git"
  | "root-read-slow"
  | "root-read-failed";

export interface LaunchPreflightWarning {
  readonly code: LaunchPreflightWarningCode;
  readonly message: string;
}

export interface LaunchPreflightResult {
  readonly warnings: ReadonlyArray<LaunchPreflightWarning>;
}

export type LaunchPreflightProbeFailureReason = "unavailable" | "timeout" | "failed";

export class LaunchPreflightProbeError extends Data.TaggedError("LaunchPreflightProbeError")<{
  readonly reason: LaunchPreflightProbeFailureReason;
  readonly detail: string;
}> {}

export interface LaunchPreflightGitProbe {
  /** Returns the parsed Git version, or null when the output had none. */
  readonly version: (root: string) => Effect.Effect<string | null, LaunchPreflightProbeError>;
}

export interface LaunchPreflightFileProbe {
  readonly exists: (target: string) => Effect.Effect<boolean>;
  /** Reads at most `maxBytes` and returns the number of bytes read. */
  readonly readFirstBytes: (
    target: string,
    maxBytes: number,
  ) => Effect.Effect<number, LaunchPreflightProbeError>;
  readonly listDirectory: (
    target: string,
  ) => Effect.Effect<ReadonlyArray<string>, LaunchPreflightProbeError>;
}

export interface LaunchPreflightInput {
  readonly root: string;
  readonly git: LaunchPreflightGitProbe;
  readonly files: LaunchPreflightFileProbe;
}

const parseGitVersion = (output: string): string | null =>
  output.match(GIT_VERSION_PATTERN)?.[1] ?? null;

/**
 * Runs every probe against `root` and returns actionable warnings. Bounded by
 * construction: each capability call is wrapped in its own timeout, so a stalled
 * executable or filesystem cannot hold the launch indefinitely.
 */
export const runLaunchPreflight = (
  input: LaunchPreflightInput,
): Effect.Effect<LaunchPreflightResult, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const warnings: LaunchPreflightWarning[] = [];
    const existsBounded = (target: string) =>
      input.files.exists(target).pipe(
        Effect.timeoutOption(EXISTS_PROBE_TIMEOUT),
        Effect.map(Option.getOrElse(() => false)),
        Effect.orElseSucceed(() => false),
      );

    const gitOutcome = yield* input.git.version(input.root).pipe(
      Effect.map((version) => ({ _tag: "ok" as const, version })),
      Effect.catch((error) => Effect.succeed({ _tag: "error" as const, error })),
      Effect.timeoutOption(GIT_PROBE_TIMEOUT),
      Effect.map(Option.getOrElse(() => ({ _tag: "timeout" as const }))),
    );

    if (gitOutcome._tag === "ok") {
      if (gitOutcome.version === null) {
        warnings.push({
          code: "git-probe-failed",
          message:
            "The Git version probe returned no version. Sessions that checkpoint, diff, or open a repository may fail.",
        });
      } else if (compareSemverVersions(gitOutcome.version, MINIMUM_GIT_VERSION) < 0) {
        warnings.push({
          code: "git-too-old",
          message:
            `Git ${gitOutcome.version} is older than the ${MINIMUM_GIT_VERSION} T3 Code requires ` +
            "(`git rev-parse --path-format`). Put a newer Git earlier on PATH " +
            "(for example /usr/local/bin before /usr/bin) and restart T3 Code.",
        });
      }
    } else if (gitOutcome._tag === "timeout" || gitOutcome.error.reason === "timeout") {
      warnings.push({
        code: "git-probe-timed-out",
        message:
          "The Git version probe did not finish in time. Git or the session-root filesystem may be " +
          "stalled; Git-backed sessions may hang. Materialize the root and check the Git install.",
      });
    } else if (gitOutcome.error.reason === "unavailable") {
      warnings.push({
        code: "git-startup-failed",
        message:
          "Git could not be started from the session-root PATH (not found or not executable). " +
          "Sessions that checkpoint, diff, or open a repository will fail. Install Git or put its " +
          "directory earlier on PATH, then restart T3 Code.",
      });
    } else {
      warnings.push({
        code: "git-probe-failed",
        message:
          `The Git version probe failed (${gitOutcome.error.detail}). Git-backed sessions may fail.`,
      });
    }

    const rootGitPresent = yield* existsBounded(path.join(input.root, ".git"));
    if (rootGitPresent) {
      const children = yield* input.files.listDirectory(input.root).pipe(
        Effect.timeoutOption(ROOT_LIST_TIMEOUT),
        Effect.map(Option.getOrElse((): ReadonlyArray<string> => [])),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );
      const nestedRepo = yield* Effect.forEach(
        children.slice(0, MAX_ROOT_CHILDREN),
        (child) => existsBounded(path.join(input.root, child, ".git")),
        { concurrency: 4 },
      );
      if (nestedRepo.some(Boolean)) {
        warnings.push({
          code: "shared-root-git",
          message:
            `The shared session root ${input.root} contains a .git and nested repositories. ` +
            "Projects beneath it will share one repository, and T3 checkpoints may be written into " +
            `that umbrella. Move or retire ${path.join(input.root, ".git")} if it is unintended.`,
        });
      }
    }

    let readTarget: string | undefined;
    for (const relativePath of READ_PROBE_CANDIDATES) {
      const candidate = path.join(input.root, relativePath);
      if (yield* existsBounded(candidate)) {
        readTarget = candidate;
        break;
      }
    }

    if (readTarget !== undefined) {
      const readOutcome = yield* input.files.readFirstBytes(readTarget, READ_PROBE_MAX_BYTES).pipe(
        Effect.map((bytes) => ({ _tag: "ok" as const, bytes })),
        Effect.catch((error) => Effect.succeed({ _tag: "error" as const, error })),
        Effect.timeoutOption(READ_PROBE_TIMEOUT),
        Effect.map(Option.getOrElse(() => ({ _tag: "timeout" as const }))),
      );
      if (readOutcome._tag === "timeout") {
        warnings.push({
          code: "root-read-slow",
          message:
            `Reading ${readTarget} under the session root did not finish in time. The filesystem may ` +
            'be stalled or cloud-offloaded; use "Keep Downloaded" on the folder before starting ' +
            "sessions.",
        });
      } else if (readOutcome._tag === "error") {
        warnings.push({
          code: "root-read-failed",
          message:
            `Could not read ${readTarget} under the session root (${readOutcome.error.detail}). ` +
            "Sessions may fail to read the workspace.",
        });
      }
    }

    return { warnings } satisfies LaunchPreflightResult;
  });

const classifyGitProbeError = (error: VcsError): LaunchPreflightProbeError => {
  if (error._tag === "VcsProcessSpawnError") {
    return new LaunchPreflightProbeError({ reason: "unavailable", detail: error.message });
  }
  if (error._tag === "VcsProcessTimeoutError") {
    return new LaunchPreflightProbeError({ reason: "timeout", detail: error.message });
  }
  return new LaunchPreflightProbeError({ reason: "failed", detail: error.message });
};

export class LaunchPreflight extends Context.Service<
  LaunchPreflight,
  {
    readonly run: (root: string) => Effect.Effect<LaunchPreflightResult>;
  }
>()("t3/environment/LaunchPreflight") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const git: LaunchPreflightGitProbe = {
    version: (root) =>
      vcsProcess
        .run({
          operation: "launch-preflight.git-version",
          command: "git",
          args: ["--version"],
          cwd: root,
          timeoutMs: 3_000,
          maxOutputBytes: 8_000,
        })
        .pipe(
          Effect.map((result) => parseGitVersion(result.stdout) ?? parseGitVersion(result.stderr)),
          Effect.mapError(classifyGitProbeError),
        ),
  };

  const files: LaunchPreflightFileProbe = {
    exists: (target) => fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false)),
    readFirstBytes: (target, maxBytes) =>
      fileSystem.stream(target, { bytesToRead: maxBytes }).pipe(
        Stream.runCount,
        Effect.mapError(
          (cause) => new LaunchPreflightProbeError({ reason: "failed", detail: String(cause) }),
        ),
      ),
    listDirectory: (target) =>
      fileSystem.readDirectory(target).pipe(
        Effect.mapError(
          (cause) => new LaunchPreflightProbeError({ reason: "failed", detail: String(cause) }),
        ),
      ),
  };

  return LaunchPreflight.of({
    run: (root: string) =>
      runLaunchPreflight({ root, git, files }).pipe(Effect.provideService(Path.Path, path)),
  });
});

export const layer = Layer.effect(LaunchPreflight, make);
