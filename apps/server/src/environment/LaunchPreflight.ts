import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { VcsError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";

/**
 * Automatic launch preflight for the server's shared session root.
 *
 * The root is `ServerConfig.cwd`: the directory provider sessions default to and
 * the directory auto-bootstrap roots a project at. Before sessions start, this
 * checks the environment the harness actually depends on:
 *
 * - the `git` executable the launch actually resolves can start, and supports
 *   the `rev-parse --path-format=absolute` capability `GitVcsDriver` relies on;
 * - an accidental umbrella repository at the shared root is flagged, using the
 *   effective Git identity (not a folder name), because every project beneath it
 *   would then share one repository and T3 checkpoints could be written into it;
 * - one small, relevant file at the root is read to detect a stalled or
 *   cloud-offloaded filesystem without scanning the tree.
 *
 * Every probe is bounded, read-only and local. The preflight never mutates Git
 * metadata, disables sync, kills processes, or calls a model. It warns by
 * default and only blocks the launch for a demonstrated inability to execute
 * usefully: when the resolved Git cannot start or lacks the required capability
 * *and* the exact session root is itself a repository, so T3 checkpoints cannot
 * be written. Broad roots, optional capabilities and unexpected markers alone
 * never block.
 */

/**
 * `GitVcsDriver` checkpoint capture runs
 * `git rev-parse --path-format=absolute --git-path index`, which needs Git
 * 2.31.0 or newer. Reported only as context; the capability probe itself is what
 * decides, not an arbitrary version threshold.
 */
export const MINIMUM_GIT_VERSION = "2.31.0";

const GIT_PROBE_TIMEOUT = "1500 millis";
const EXISTS_PROBE_TIMEOUT = "500 millis";
const ROOT_LIST_TIMEOUT = "500 millis";
const READ_PROBE_TIMEOUT = "500 millis";
const TOTAL_PROBE_BUDGET = "5 seconds";
const READ_PROBE_MAX_BYTES = 32 * 1024;
const MAX_ROOT_CHILDREN = 32;
const GIT_VERSION_PATTERN = /\b(\d+\.\d+\.\d+)\b/;

/** Files probed, in order, for the bounded root read. All are small and relevant. */
const READ_PROBE_CANDIDATES = ["AGENTS.md", "package.json", "README.md", ".git/HEAD"] as const;

/** Retired Git metadata must not count as an active umbrella by name alone. */
const RETIRED_GIT_MARKER = ".git.macfix-m1-retired";

export type LaunchPreflightFindingCode =
  | "git-startup-failed"
  | "git-probe-timed-out"
  | "git-capability-missing"
  | "git-probe-failed"
  | "shared-root-git"
  | "root-read-slow"
  | "root-read-failed";

export type LaunchPreflightSeverity = "warning" | "blocker";

export interface LaunchPreflightFinding {
  readonly code: LaunchPreflightFindingCode;
  readonly severity: LaunchPreflightSeverity;
  readonly message: string;
}

export interface LaunchPreflightResult {
  readonly findings: ReadonlyArray<LaunchPreflightFinding>;
  readonly warnings: ReadonlyArray<LaunchPreflightFinding>;
  readonly blockers: ReadonlyArray<LaunchPreflightFinding>;
}

export type LaunchPreflightProbeFailureReason = "unavailable" | "timeout" | "failed";

export class LaunchPreflightProbeError extends Data.TaggedError("LaunchPreflightProbeError")<{
  readonly reason: LaunchPreflightProbeFailureReason;
  readonly detail: string;
}> {}

export interface LaunchPreflightGitProbe {
  /** Returns the parsed Git version, or null when the output had none. */
  readonly version: (root: string) => Effect.Effect<string | null, LaunchPreflightProbeError>;
  /**
   * Runs the exact capability `GitVcsDriver` needs and resolves the effective
   * repository identity for the root. Uses `allowNonZeroExit`, so "not a
   * repository" and "unsupported option" are observable states, not failures.
   */
  readonly resolveIdentity: (
    root: string,
  ) => Effect.Effect<LaunchPreflightRepoIdentity, LaunchPreflightProbeError>;
}

export interface LaunchPreflightRepoIdentity {
  readonly state: "ok" | "not-a-repository" | "unsupported" | "failed";
  /** Effective work-tree top level when `state` is "ok". */
  readonly topLevel: string | null;
  /** Effective common Git directory when `state` is "ok". */
  readonly commonDir: string | null;
  readonly detail: string;
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

const severityForGitFailure = (rootGitMarker: boolean): LaunchPreflightSeverity =>
  rootGitMarker ? "blocker" : "warning";

const blockerSuffix =
  " T3 Code cannot checkpoint this repository, so the session cannot run usefully." +
  " Fix Git, then restart T3 Code.";

/**
 * Runs every probe against `root` and returns findings. Bounded by construction:
 * each capability call has its own timeout, the whole exploration is capped by
 * {@link TOTAL_PROBE_BUDGET}, and the Git subprocesses carry their own bounds.
 */
export const runLaunchPreflight = (
  input: LaunchPreflightInput,
): Effect.Effect<LaunchPreflightResult, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const collected = yield* Ref.make<ReadonlyArray<LaunchPreflightFinding>>([]);
    const add = (finding: LaunchPreflightFinding) =>
      Ref.update(collected, (current) => [...current, finding]);

    const existsBounded = (target: string) =>
      input.files.exists(target).pipe(
        Effect.timeoutOption(EXISTS_PROBE_TIMEOUT),
        Effect.map(Option.getOrElse(() => false)),
        Effect.orElseSucceed(() => false),
      );

    const explore = Effect.gen(function* () {
      // `root/.git` (a directory or a worktree/submodule file) is the evidence
      // that the root is expected to be a repository. A retired marker such as
      // `.git.macfix-m1-retired` is a different path and is never counted.
      const rootGitMarker = yield* existsBounded(path.join(input.root, ".git"));

      const gitOutcome = yield* input.git.version(input.root).pipe(
        Effect.map((version) => ({ _tag: "ok" as const, version })),
        Effect.catch((error) => Effect.succeed({ _tag: "error" as const, error })),
        Effect.timeoutOption(GIT_PROBE_TIMEOUT),
        Effect.map(Option.getOrElse(() => ({ _tag: "timeout" as const }))),
      );

      let effectiveRootRepository = rootGitMarker;

      if (gitOutcome._tag === "ok") {
        if (gitOutcome.version === null) {
          yield* add({
            code: "git-probe-failed",
            severity: "warning",
            message:
              "The Git version probe returned no version. Sessions that checkpoint, diff, or open a repository may fail.",
          });
        }

        const identityOutcome = yield* input.git.resolveIdentity(input.root).pipe(
          Effect.map((identity) => ({ _tag: "ok" as const, identity })),
          Effect.catch((error) => Effect.succeed({ _tag: "error" as const, error })),
          Effect.timeoutOption(GIT_PROBE_TIMEOUT),
          Effect.map(Option.getOrElse(() => ({ _tag: "timeout" as const }))),
        );

        if (identityOutcome._tag === "ok") {
          const identity = identityOutcome.identity;
          switch (identity.state) {
            case "ok": {
              effectiveRootRepository = true;
              break;
            }
            case "unsupported": {
              yield* add({
                code: "git-capability-missing",
                severity: severityForGitFailure(rootGitMarker),
                message:
                  "The Git this launch resolves does not support `git rev-parse --path-format`, which T3 " +
                  `Code ${MINIMUM_GIT_VERSION}+ uses to checkpoint changes.` +
                  (rootGitMarker
                    ? blockerSuffix
                    : " Put a newer Git earlier on PATH (for example /usr/local/bin before /usr/bin) and restart T3 Code."),
              });
              break;
            }
            case "not-a-repository": {
              effectiveRootRepository = false;
              break;
            }
            case "failed": {
              yield* add({
                code: "git-probe-failed",
                severity: "warning",
                message:
                  "The Git repository probe failed. Git-backed sessions may fail; check the Git install and the session-root filesystem.",
              });
              break;
            }
          }
        } else if (identityOutcome._tag === "timeout") {
          yield* add({
            code: "git-probe-timed-out",
            severity: severityForGitFailure(rootGitMarker),
            message:
              "The Git repository probe did not finish in time. Git or the session-root filesystem may be " +
              "stalled; Git-backed sessions may hang. Materialize the root and check the Git install." +
              (rootGitMarker ? blockerSuffix : ""),
          });
        } else {
          yield* add({
            code: "git-probe-failed",
            severity: "warning",
            message:
              `The Git repository probe failed (${identityOutcome.error.detail}). Git-backed sessions may fail.`,
          });
        }
      } else if (gitOutcome._tag === "timeout" || gitOutcome.error.reason === "timeout") {
        yield* add({
          code: "git-probe-timed-out",
          severity: severityForGitFailure(rootGitMarker),
          message:
            "The Git version probe did not finish in time. Git or the session-root filesystem may be " +
            "stalled; Git-backed sessions may hang. Materialize the root and check the Git install." +
            (rootGitMarker ? blockerSuffix : ""),
        });
      } else if (gitOutcome.error.reason === "unavailable") {
        yield* add({
          code: "git-startup-failed",
          severity: severityForGitFailure(rootGitMarker),
          message:
            "Git could not be started from the session-root PATH (not found or not executable)." +
            (rootGitMarker
              ? blockerSuffix
              : " Sessions that checkpoint, diff, or open a repository will fail. Install Git or put its " +
                "directory earlier on PATH, then restart T3 Code."),
        });
      } else {
        yield* add({
          code: "git-probe-failed",
          severity: "warning",
          message:
            `The Git version probe failed (${gitOutcome.error.detail}). Git-backed sessions may fail.`,
        });
      }

      if (effectiveRootRepository) {
        const children = yield* input.files.listDirectory(input.root).pipe(
          Effect.timeoutOption(ROOT_LIST_TIMEOUT),
          Effect.map(Option.getOrElse((): ReadonlyArray<string> => [])),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );
        const nestedRepo = yield* Effect.forEach(
          children
            .filter(
              (child) =>
                child.length > 0 && child !== "." && child !== ".." && child !== RETIRED_GIT_MARKER,
            )
            .slice(0, MAX_ROOT_CHILDREN),
          (child) => existsBounded(path.join(input.root, child, ".git")),
          { concurrency: 8 },
        );
        if (nestedRepo.some(Boolean)) {
          yield* add({
            code: "shared-root-git",
            severity: "warning",
            message:
              `The shared session root ${input.root} is itself a Git repository and contains nested ` +
              "repositories. Projects beneath it will share one repository, and T3 checkpoints may be " +
              `written into that umbrella. Move or retire ${path.join(input.root, ".git")} if it is unintended.`,
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
          yield* add({
            code: "root-read-slow",
            severity: "warning",
            message:
              `Reading ${readTarget} under the session root did not finish in time. The filesystem may ` +
              'be stalled or cloud-offloaded; use "Keep Downloaded" on the folder before starting ' +
              "sessions.",
          });
        } else if (readOutcome._tag === "error") {
          yield* add({
            code: "root-read-failed",
            severity: "warning",
            message:
              `Could not read ${readTarget} under the session root (${readOutcome.error.detail}). ` +
              "Sessions may fail to read the workspace.",
          });
        }
      }
    });

    // The whole exploration shares one wall-clock budget. Findings already
    // collected survive a mid-probe timeout; a probe that cannot be interrupted
    // is still individually bounded above.
    yield* explore.pipe(Effect.timeoutOption(TOTAL_PROBE_BUDGET));

    const findings = yield* Ref.get(collected);
    return {
      findings,
      warnings: findings.filter((finding) => finding.severity === "warning"),
      blockers: findings.filter((finding) => finding.severity === "blocker"),
    } satisfies LaunchPreflightResult;
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

const classifyIdentityOutput = (output: { stdout: string; stderr: string; code: number }): LaunchPreflightRepoIdentity => {
  const stderr = output.stderr.trim();
  if (output.code === 0) {
    const lines = output.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return {
      state: "ok",
      topLevel: lines[0] ?? null,
      commonDir: lines[1] ?? null,
      detail: "",
    };
  }
  if (/not a git repository/i.test(stderr) || /must be run in a work tree/i.test(stderr)) {
    return { state: "not-a-repository", topLevel: null, commonDir: null, detail: stderr };
  }
  if (/unknown option|usage: git rev-parse|path-format/i.test(stderr)) {
    return { state: "unsupported", topLevel: null, commonDir: null, detail: stderr };
  }
  return { state: "failed", topLevel: null, commonDir: null, detail: stderr };
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
          timeoutMs: 1_500,
          maxOutputBytes: 4_000,
        })
        .pipe(
          Effect.map((result) => parseGitVersion(result.stdout) ?? parseGitVersion(result.stderr)),
          Effect.mapError(classifyGitProbeError),
        ),
    resolveIdentity: (root) =>
      vcsProcess
        .run({
          operation: "launch-preflight.git-identity",
          command: "git",
          args: ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
          cwd: root,
          timeoutMs: 1_500,
          maxOutputBytes: 4_000,
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.map((result) =>
            classifyIdentityOutput({
              stdout: result.stdout,
              stderr: result.stderr,
              code: Number(result.exitCode),
            }),
          ),
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
