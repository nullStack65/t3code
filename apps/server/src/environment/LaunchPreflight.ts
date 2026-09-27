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
 * - the `git` executable the launch actually resolves can start;
 * - an accidental umbrella repository at an explicitly configured shared root
 *   is flagged using the exact, normalized Git identity reported for that root
 *   (never a folder name, a child count, or child enumeration);
 * - one small, relevant file at the root is read to detect a stalled or
 *   cloud-offloaded filesystem without scanning the tree.
 *
 * Every probe is bounded, read-only and local. The preflight never mutates Git
 * metadata, disables sync, kills processes, or calls a model. Findings warn by
 * default. A blocker is emitted only for a demonstrated inability to execute
 * usefully — the resolved Git cannot start while the exact session root is a
 * repository, so its worktree/checkpoint plumbing cannot run. Optional Git
 * capabilities (`rev-parse --path-format`) never block: maintained
 * `GitVcsDriver` catches that failure and rebuilds the temporary index. Broad
 * roots, nested regular repositories and retired markers never block.
 */

const GIT_PROBE_TIMEOUT = "1500 millis";
const NARROW_FS_TIMEOUT = "500 millis";
const READ_PROBE_TIMEOUT = "500 millis";
const TOTAL_PROBE_BUDGET = "5 seconds";
const READ_PROBE_MAX_BYTES = 32 * 1024;
const GIT_VERSION_PATTERN = /\b(\d+\.\d+\.\d+)\b/;

/** Files probed, in order, for the bounded root read. All are small and relevant. */
const READ_PROBE_CANDIDATES = ["AGENTS.md", "package.json", "README.md", ".git/HEAD"] as const;

export type LaunchPreflightFindingCode =
  | "git-startup-failed"
  | "git-probe-timed-out"
  | "git-index-fast-path-unavailable"
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
   * Resolves the effective repository identity for the root using plain
   * `git rev-parse --show-toplevel` / `--git-common-dir` queries. Uses
   * `allowNonZeroExit`, so "not a repository" is an observable state, not a
   * failure. Never depends on the optional `--path-format` flag.
   */
  readonly resolveIdentity: (
    root: string,
  ) => Effect.Effect<LaunchPreflightRepoIdentity, LaunchPreflightProbeError>;
  /**
   * Probes the optional `rev-parse --path-format=absolute` convenience used by
   * the checkpoint index-reuse fast path. `unsupported` only means the faster
   * path is unavailable — the fallback still checkpoints — so it never blocks.
   */
  readonly probeIndexFastPath: (
    root: string,
  ) => Effect.Effect<LaunchPreflightIndexFastPath, LaunchPreflightProbeError>;
}

export type LaunchPreflightIndexFastPath = "supported" | "unsupported" | "unknown";

export interface LaunchPreflightRepoIdentity {
  readonly state: "ok" | "not-a-repository" | "failed";
  /** Effective work-tree top level when `state` is "ok". */
  readonly topLevel: string | null;
  /** Effective common Git directory (resolved) when `state` is "ok". */
  readonly commonDir: string | null;
  readonly detail: string;
}

export interface LaunchPreflightFileProbe {
  readonly exists: (target: string) => Effect.Effect<boolean>;
  /**
   * Canonicalizes a path (resolving symlinks) so exact root identity compares
   * correctly across `/var` ↔ `/private/var` style aliases. Returns null when it
   * cannot be resolved.
   */
  readonly realPath: (target: string) => Effect.Effect<string | null>;
  /** Reads at most `maxBytes` and returns the number of bytes read. */
  readonly readFirstBytes: (
    target: string,
    maxBytes: number,
  ) => Effect.Effect<number, LaunchPreflightProbeError>;
}

export interface LaunchPreflightInput {
  readonly root: string;
  readonly git: LaunchPreflightGitProbe;
  readonly files: LaunchPreflightFileProbe;
  /**
   * Whether `root` is an explicitly configured shared session root (as opposed
   * to a selected nested repository). Only a shared root that is *itself* a
   * repository is reported as an unexpected umbrella.
   */
  readonly isSharedRoot?: boolean;
}

const parseGitVersion = (output: string): string | null =>
  output.match(GIT_VERSION_PATTERN)?.[1] ?? null;

const blockerSuffix =
  " T3 Code cannot checkpoint or resolve a worktree for this repository, so the session cannot run" +
  " usefully. Fix Git, then restart T3 Code.";

const normalizeForCompare = (path: Path.Path, value: string): string => {
  const resolved = path.resolve(value);
  // A trailing separator would make an otherwise-equal path compare unequal.
  return resolved.length > 1 && resolved.endsWith(path.sep)
    ? resolved.slice(0, -path.sep.length)
    : resolved;
};

const samePath = (path: Path.Path, a: string | null, b: string): boolean =>
  a !== null && normalizeForCompare(path, a) === normalizeForCompare(path, b);

const isInside = (path: Path.Path, child: string | null, parent: string): boolean => {
  if (child === null) return false;
  const normalizedChild = normalizeForCompare(path, child);
  const normalizedParent = normalizeForCompare(path, parent);
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(`${normalizedParent}${path.sep}`)
  );
};

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
    const isSharedRoot = input.isSharedRoot === true;
    const collected = yield* Ref.make<ReadonlyArray<LaunchPreflightFinding>>([]);
    const add = (finding: LaunchPreflightFinding) =>
      Ref.update(collected, (current) => [...current, finding]);

    const existsBounded = (target: string) =>
      input.files.exists(target).pipe(
        Effect.timeoutOption(NARROW_FS_TIMEOUT),
        Effect.map(Option.getOrElse(() => false)),
        Effect.orElseSucceed(() => false),
      );

    const realPathBounded = (target: string) =>
      input.files.realPath(target).pipe(
        Effect.timeoutOption(NARROW_FS_TIMEOUT),
        Effect.map(Option.getOrElse(() => null)),
        Effect.orElseSucceed(() => null),
      );

    const explore = Effect.gen(function* () {
      // Canonicalize the configured root once so identity comparison is not
      // confused by macOS `/var` ↔ `/private/var` aliases.
      const canonicalRoot = (yield* realPathBounded(input.root)) ?? input.root;

      // Only a real `.git` entry counts as repository evidence. A retired marker
      // such as `.git.macfix-m1-retired` is a different path and is ignored.
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
              // Exact normalized root identity: the root itself is the work tree
              // top level. `topLevel === root` is what makes a shared root an
              // umbrella; a nested repository selected as the session cwd has a
              // different top level and stays an ordinary repository session.
              const rootIsRepository = samePath(path, identity.topLevel, canonicalRoot);
              effectiveRootRepository = rootIsRepository || rootGitMarker;
              if (isSharedRoot && rootIsRepository) {
                const commonUnderRoot = isInside(path, identity.commonDir, canonicalRoot);
                yield* add({
                  code: "shared-root-git",
                  severity: "warning",
                  message:
                    `The shared session root ${input.root} is itself a Git repository ` +
                    `(top-level ${identity.topLevel ?? input.root}). Projects beneath it would share that ` +
                    "repository." +
                    (commonUnderRoot
                      ? ` Move or retire ${path.join(input.root, ".git")} if that is unintended.`
                      : " Its Git identity points at a different repository; no change to this root is implied."),
                });
              }
              break;
            }
            case "not-a-repository": {
              effectiveRootRepository = rootGitMarker;
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
            severity: "warning",
            message:
              "The Git repository probe did not finish in time. Git or the session-root filesystem may be " +
              "stalled; Git-backed sessions may hang. Materialize the root and check the Git install.",
          });
        } else {
          yield* add({
            code: "git-probe-failed",
            severity: "warning",
            message: `The Git repository probe failed (${identityOutcome.error.detail}). Git-backed sessions may fail.`,
          });
        }

        // The optional index-reuse fast path is probed for context only. Its
        // absence is handled by GitVcsDriver's temporary-index fallback and must
        // never block a launch.
        const fastPathOutcome = yield* input.git.probeIndexFastPath(input.root).pipe(
          Effect.map((state) => ({ _tag: "ok" as const, state })),
          Effect.catch((error) => Effect.succeed({ _tag: "error" as const, error })),
          Effect.timeoutOption(GIT_PROBE_TIMEOUT),
          Effect.map(Option.getOrElse(() => ({ _tag: "timeout" as const }))),
        );
        if (fastPathOutcome._tag === "ok" && fastPathOutcome.state === "unsupported") {
          yield* add({
            code: "git-index-fast-path-unavailable",
            severity: "warning",
            message:
              "The Git this launch resolves does not support `git rev-parse --path-format`. T3 Code will " +
              "rebuild the temporary checkpoint index instead of reusing the on-disk index; sessions still " +
              "run and checkpoint. A newer Git restores the faster path only.",
          });
        }
      } else if (gitOutcome._tag === "timeout" || gitOutcome.error.reason === "timeout") {
        yield* add({
          code: "git-probe-timed-out",
          severity: "warning",
          message:
            "The Git version probe did not finish in time. Git or the session-root filesystem may be " +
            "stalled; Git-backed sessions may hang. Materialize the root and check the Git install.",
        });
      } else if (gitOutcome.error.reason === "unavailable") {
        yield* add({
          code: "git-startup-failed",
          severity: effectiveRootRepository ? "blocker" : "warning",
          message:
            "Git could not be started from the session-root PATH (not found or not executable)." +
            (effectiveRootRepository
              ? blockerSuffix
              : " Sessions that checkpoint, diff, or open a repository will fail. Install Git or put its " +
                "directory earlier on PATH, then restart T3 Code."),
        });
      } else {
        yield* add({
          code: "git-probe-failed",
          severity: "warning",
          message: `The Git version probe failed (${gitOutcome.error.detail}). Git-backed sessions may fail.`,
        });
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
        const readOutcome = yield* input.files
          .readFirstBytes(readTarget, READ_PROBE_MAX_BYTES)
          .pipe(
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

export class LaunchPreflight extends Context.Service<
  LaunchPreflight,
  {
    readonly run: (
      root: string,
      options?: { readonly isSharedRoot?: boolean },
    ) => Effect.Effect<LaunchPreflightResult>;
  }
>()("t3/environment/LaunchPreflight") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const runGit = (
    operation: string,
    root: string,
    args: ReadonlyArray<string>,
    allowNonZeroExit: boolean,
  ) =>
    vcsProcess
      .run({
        operation,
        command: "git",
        args,
        cwd: root,
        timeoutMs: 1_500,
        maxOutputBytes: 4_000,
        ...(allowNonZeroExit ? { allowNonZeroExit: true } : {}),
      })
      .pipe(Effect.mapError(classifyGitProbeError));

  const git: LaunchPreflightGitProbe = {
    version: (root) =>
      runGit("launch-preflight.git-version", root, ["--version"], false).pipe(
        Effect.map((result) => parseGitVersion(result.stdout) ?? parseGitVersion(result.stderr)),
      ),
    resolveIdentity: (root) =>
      Effect.gen(function* () {
        const top = yield* runGit(
          "launch-preflight.git-toplevel",
          root,
          ["rev-parse", "--show-toplevel"],
          true,
        );
        if (Number(top.exitCode) !== 0) {
          const stderr = top.stderr.trim();
          if (/not a git repository/i.test(stderr) || /must be run in a work tree/i.test(stderr)) {
            return {
              state: "not-a-repository",
              topLevel: null,
              commonDir: null,
              detail: stderr,
            } satisfies LaunchPreflightRepoIdentity;
          }
          return {
            state: "failed",
            topLevel: null,
            commonDir: null,
            detail: stderr,
          } satisfies LaunchPreflightRepoIdentity;
        }
        const topLevel = top.stdout.trim();
        const commonResult = yield* runGit(
          "launch-preflight.git-common-dir",
          root,
          ["rev-parse", "--git-common-dir"],
          true,
        );
        const rawCommonDir = Number(commonResult.exitCode) === 0 ? commonResult.stdout.trim() : "";
        const commonDir =
          rawCommonDir.length > 0
            ? path.isAbsolute(rawCommonDir)
              ? rawCommonDir
              : path.resolve(topLevel.length > 0 ? topLevel : root, rawCommonDir)
            : null;
        return {
          state: "ok",
          topLevel: topLevel.length > 0 ? topLevel : null,
          commonDir,
          detail: "",
        } satisfies LaunchPreflightRepoIdentity;
      }),
    probeIndexFastPath: (root) =>
      runGit(
        "launch-preflight.git-index-fast-path",
        root,
        ["rev-parse", "--path-format=absolute", "--git-path", "index"],
        true,
      ).pipe(
        Effect.map((result): LaunchPreflightIndexFastPath => {
          if (Number(result.exitCode) === 0) return "supported";
          const stderr = result.stderr.trim();
          if (/unknown option|usage: git rev-parse|path-format/i.test(stderr)) {
            return "unsupported";
          }
          return "unknown";
        }),
      ),
  };

  const files: LaunchPreflightFileProbe = {
    exists: (target) => fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false)),
    realPath: (target) => fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => null)),
    readFirstBytes: (target, maxBytes) =>
      fileSystem.stream(target, { bytesToRead: maxBytes }).pipe(
        Stream.runCount,
        Effect.mapError(
          (cause) => new LaunchPreflightProbeError({ reason: "failed", detail: String(cause) }),
        ),
      ),
  };

  return LaunchPreflight.of({
    run: (root: string, options?: { readonly isSharedRoot?: boolean }) =>
      runLaunchPreflight({
        root,
        git,
        files,
        ...(options?.isSharedRoot !== undefined ? { isSharedRoot: options.isSharedRoot } : {}),
      }).pipe(Effect.provideService(Path.Path, path)),
  });
});

export const layer = Layer.effect(LaunchPreflight, make);
