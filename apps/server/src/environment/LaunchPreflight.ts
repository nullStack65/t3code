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
  | "git-sparse-add-unsupported"
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
  readonly version: (
    root: string,
    env?: NodeJS.ProcessEnv,
  ) => Effect.Effect<string | null, LaunchPreflightProbeError>;
  /**
   * Resolves the effective repository identity for the root using plain
   * `git rev-parse --show-toplevel` / `--git-common-dir` queries. Uses
   * `allowNonZeroExit`, so "not a repository" is an observable state, not a
   * failure. Never depends on the optional `--path-format` flag.
   */
  readonly resolveIdentity: (
    root: string,
    env?: NodeJS.ProcessEnv,
  ) => Effect.Effect<LaunchPreflightRepoIdentity, LaunchPreflightProbeError>;
  /**
   * Read-only: whether the root repository is a sparse checkout
   * (`git config --bool core.sparseCheckout`). This establishes the
   * repository-side applicability of `git add --sparse` separately from the
   * consumer, so an incomplete capability probe can still be recognized as
   * relevant. Uses `allowNonZeroExit`, so a missing key is `false`, not a
   * failure.
   */
  readonly isSparseCheckout: (
    root: string,
    env?: NodeJS.ProcessEnv,
  ) => Effect.Effect<boolean, LaunchPreflightProbeError>;
  /**
   * Probes the real capability `git add --sparse`. Read-only: it inspects
   * `git add -h`, never stages anything. The caller decides applicability (a
   * verified sparse checkout or the selected consumer) and only probes when the
   * capability is relevant. The optional `rev-parse --path-format` fast path is
   * deliberately not probed or warned about: its absence is a harmless
   * optimization fallback handled inside `GitVcsDriver`.
   */
  readonly probeSparseAdd: (
    root: string,
    env?: NodeJS.ProcessEnv,
  ) => Effect.Effect<LaunchPreflightSparseCapability, LaunchPreflightProbeError>;
}

export type LaunchPreflightSparseCapability = "supported" | "unsupported";

/**
 * The consumer/operation about to run. `--sparse` applicability belongs to the
 * consumer: OpenCode's snapshot staging uses `git add --all --sparse` whenever
 * snapshots are enabled and the project is a Git repository, regardless of
 * `core.sparseCheckout`. T3's own checkpoint path only uses `--sparse` in a
 * sparse checkout.
 */
export interface LaunchPreflightConsumer {
  /** Provider driver kind selected for this launch (e.g. "opencode"). */
  readonly driver: string;
  /**
   * Whether OpenCode-style snapshot staging is enabled for this launch.
   * `undefined` means the effective configuration could not be read, so the
   * requirement is not asserted; only an explicit `true` requires `--sparse`.
   */
  readonly snapshotsEnabled: boolean | undefined;
}

/** Whether the selected consumer/operation stages with `git add --sparse`. */
export const consumerUsesSparseAdd = (consumer: LaunchPreflightConsumer | undefined): boolean =>
  consumer !== undefined && consumer.driver === "opencode" && consumer.snapshotsEnabled === true;

export interface LaunchPreflightRepoIdentity {
  readonly state: "ok" | "not-a-repository" | "failed";
  /** Effective work-tree top level when `state` is "ok". */
  readonly topLevel: string | null;
  /** Effective common Git directory (resolved) when `state` is "ok". */
  readonly commonDir: string | null;
  readonly detail: string;
}

export type LaunchPreflightFsEntryType = "directory" | "file" | "other" | "missing";

export interface LaunchPreflightFsEntry {
  readonly type: LaunchPreflightFsEntryType;
}

export interface LaunchPreflightFileProbe {
  /**
   * Presence check that keeps genuine absence distinct from a failed metadata
   * read. Returns `false` only when the entry is genuinely absent; a
   * denied/stalled/I-O-failed lookup is a `LaunchPreflightProbeError` so the
   * caller can warn instead of reading it as absence.
   */
  readonly exists: (target: string) => Effect.Effect<boolean, LaunchPreflightProbeError>;
  /**
   * Bounded-type stat. Genuine absence is the observable `"missing"` state, so
   * callers can keep it distinct from a denied/stalled metadata read. Any other
   * stat error is a `LaunchPreflightProbeError`.
   */
  readonly stat: (
    target: string,
  ) => Effect.Effect<LaunchPreflightFsEntry, LaunchPreflightProbeError>;
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
   * repository is reported as an unexpected umbrella. When `configuredRoot` is
   * provided, this boolean is derived from a bounded canonical comparison
   * instead of being trusted as given.
   */
  readonly isSharedRoot?: boolean;
  /**
   * The explicitly configured shared session root, as spelled in settings. The
   * preflight canonicalizes it against the actual root through the same bounded
   * filesystem probe so alias spellings of the same physical root
   * (`/var` ↔ `/private/var`, a Windows junction) still recognize shared intent.
   * Unset or empty means no root is configured and every session is ordinary.
   */
  readonly configuredRoot?: string;
  /**
   * The selected consumer/operation. Determines whether `git add --sparse` is
   * required even in an ordinary repository (OpenCode snapshots use it there).
   * Absent means only a sparse checkout makes `--sparse` relevant.
   */
  readonly consumer?: LaunchPreflightConsumer;
  /**
   * The environment the selected provider launch actually resolves `git` with
   * (the same environment the adapter inherits). Absent means the host env.
   */
  readonly gitEnvironment?: NodeJS.ProcessEnv;
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

/** Normalizes a path into a stable key for exact-root comparisons. */
export const normalizePathKey = (path: Path.Path, value: string): string =>
  normalizeForCompare(path, value);

const samePath = (path: Path.Path, a: string | null, b: string): boolean =>
  a !== null && normalizeForCompare(path, a) === normalizeForCompare(path, b);

/**
 * Whether `cwd` is exactly the deliberately configured shared session root.
 * This is the only source of shared-inbox intent: equality with an ordinary
 * working directory (including `ServerConfig.cwd`) never declares one. An
 * unset or empty setting means every session is ordinary.
 */
export const isConfiguredSharedSessionRoot = (
  path: Path.Path,
  cwd: string,
  configuredRoot: string | undefined,
): boolean => {
  const trimmed = configuredRoot?.trim() ?? "";
  if (trimmed.length === 0) return false;
  return normalizeForCompare(path, cwd) === normalizeForCompare(path, trimmed);
};

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
    const configuredRoot = input.configuredRoot?.trim() ?? "";
    const collected = yield* Ref.make<ReadonlyArray<LaunchPreflightFinding>>([]);
    const add = (finding: LaunchPreflightFinding) =>
      Ref.update(collected, (current) => [...current, finding]);

    type ExistsOutcome =
      | { readonly state: "present" }
      | { readonly state: "absent" }
      | { readonly state: "unknown"; readonly reason: "timeout" | "failed" };

    const existsOutcome = (target: string): Effect.Effect<ExistsOutcome> =>
      input.files.exists(target).pipe(
        Effect.map((present): ExistsOutcome =>
          present ? { state: "present" } : { state: "absent" },
        ),
        Effect.catch(() => Effect.succeed({ state: "unknown", reason: "failed" } as const)),
        Effect.timeoutOption(NARROW_FS_TIMEOUT),
        Effect.map(
          Option.getOrElse((): ExistsOutcome => ({ state: "unknown", reason: "timeout" })),
        ),
      );

    const realPathBounded = (target: string) =>
      input.files.realPath(target).pipe(
        Effect.timeoutOption(NARROW_FS_TIMEOUT),
        Effect.map(Option.getOrElse(() => null)),
        Effect.orElseSucceed(() => null),
      );

    // One actionable warning shape for an incomplete filesystem metadata check.
    // Genuine absence never reaches here: only timeout/permission/other failure.
    const rootMetadataWarning = (
      target: string,
      reason: "timeout" | "failed",
    ): LaunchPreflightFinding =>
      reason === "timeout"
        ? {
            code: "root-read-slow",
            severity: "warning",
            message:
              `Inspecting ${target} under the session root did not finish in time. The filesystem may ` +
              'be stalled or cloud-offloaded; use "Keep Downloaded" on the folder before starting ' +
              "sessions.",
          }
        : {
            code: "root-read-failed",
            severity: "warning",
            message:
              `Could not inspect ${target} under the session root. The filesystem denied or failed ` +
              "the metadata read. Sessions may fail to read the workspace.",
          };

    const explore = Effect.gen(function* () {
      // Bound the initial session-cwd check here so a stalled, denied or
      // cloud-offloaded path produces one actionable warning instead of being
      // silently treated as clean. Genuine absence or a plain file stays
      // distinct: the caller's own workspace read (and
      // `ProviderWorkspaceMissingError`) reports that.
      const rootStatOutcome = yield* input.files.stat(input.root).pipe(
        Effect.map((entry) => ({ _tag: "ok" as const, entry })),
        Effect.catch((error) => Effect.succeed({ _tag: "error" as const, error })),
        Effect.timeoutOption(NARROW_FS_TIMEOUT),
        Effect.map(Option.getOrElse(() => ({ _tag: "timeout" as const }))),
      );
      if (rootStatOutcome._tag === "timeout") {
        yield* add(rootMetadataWarning(input.root, "timeout"));
        return;
      }
      if (rootStatOutcome._tag === "error") {
        yield* add(rootMetadataWarning(input.root, "failed"));
        return;
      }
      if (rootStatOutcome.entry.type !== "directory") {
        return;
      }

      // Canonicalize the configured root so identity comparison is not confused
      // by macOS `/var` ↔ `/private/var` aliases. `null` means canonicalization
      // failed: identity must then stay unknown, never affirmative external.
      const canonicalRoot = yield* realPathBounded(input.root);

      // Shared-root intent comes only from the explicit setting. When a
      // configured root is present, resolve it through the same bounded
      // canonicalization as the actual root: an alias spelling of the same
      // physical directory still counts as the shared root, while a genuinely
      // different configured root stays ordinary. Unlike a lexical compare, this
      // does not lose intent before the probe runs.
      let isSharedRoot = input.isSharedRoot === true;
      if (configuredRoot.length > 0) {
        const canonicalConfigured = yield* realPathBounded(configuredRoot);
        isSharedRoot =
          canonicalRoot !== null && canonicalConfigured !== null
            ? samePath(path, canonicalRoot, canonicalConfigured)
            : // Canonicalization failed for at least one side; a lexical compare
              // is the neutral fallback and cannot invent shared intent.
              isConfiguredSharedSessionRoot(path, input.root, configuredRoot);
      }

      // Only a real `.git` entry counts as repository evidence. A retired marker
      // such as `.git.macfix-m1-retired` is a different path and is ignored. An
      // incomplete metadata check is not absence: warn about it.
      const rootGitMarkerPath = path.join(input.root, ".git");
      const rootGitMarkerOutcome = yield* existsOutcome(rootGitMarkerPath);
      if (rootGitMarkerOutcome.state === "unknown") {
        yield* add(rootMetadataWarning(rootGitMarkerPath, rootGitMarkerOutcome.reason));
      }
      const rootGitMarker = rootGitMarkerOutcome.state === "present";

      const gitOutcome = yield* input.git.version(input.root, input.gitEnvironment).pipe(
        Effect.map((version) => ({ _tag: "ok" as const, version })),
        Effect.catch((error) => Effect.succeed({ _tag: "error" as const, error })),
        Effect.timeoutOption(GIT_PROBE_TIMEOUT),
        Effect.map(Option.getOrElse(() => ({ _tag: "timeout" as const }))),
      );

      let effectiveRootRepository = rootGitMarker;
      // Whether the root is inside a Git work tree (even when the root is a
      // subdirectory or worktree). OpenCode snapshots only run for Git projects.
      let inGitWorkTree = rootGitMarker;

      if (gitOutcome._tag === "ok") {
        if (gitOutcome.version === null) {
          yield* add({
            code: "git-probe-failed",
            severity: "warning",
            message:
              "The Git version probe returned no version. Sessions that checkpoint, diff, or open a repository may fail.",
          });
        }

        const identityOutcome = yield* input.git
          .resolveIdentity(input.root, input.gitEnvironment)
          .pipe(
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
              // Compare canonical forms when both resolve; otherwise fall back
              // to the raw spellings so a canonicalization failure cannot by
              // itself invent an umbrella.
              const topLevelCanonical =
                identity.topLevel !== null ? yield* realPathBounded(identity.topLevel) : null;
              const rootIsRepository =
                identity.topLevel !== null && canonicalRoot !== null && topLevelCanonical !== null
                  ? samePath(path, topLevelCanonical, canonicalRoot)
                  : samePath(path, identity.topLevel, input.root);
              effectiveRootRepository = rootIsRepository || rootGitMarker;
              inGitWorkTree = true;
              if (isSharedRoot && rootIsRepository) {
                // Canonicalize the (already invocation-cwd-resolved) common dir
                // before comparing, so `/var` ↔ `/private/var` alias spellings of
                // the same physical root give the local-metadata guidance.
                const commonDirCanonical =
                  identity.commonDir !== null ? yield* realPathBounded(identity.commonDir) : null;
                const commonUnderRoot =
                  canonicalRoot !== null && commonDirCanonical !== null
                    ? isInside(path, commonDirCanonical, canonicalRoot)
                    : null;
                yield* add({
                  code: "shared-root-git",
                  severity: "warning",
                  message:
                    `The shared session root ${input.root} is itself a Git repository ` +
                    `(top-level ${identity.topLevel ?? input.root}). Projects beneath it would share that ` +
                    "repository." +
                    (commonUnderRoot === true
                      ? ` Move or retire ${path.join(input.root, ".git")} if that is unintended.`
                      : commonUnderRoot === false
                        ? " Its Git identity points at a different repository; no change to this root is implied."
                        : " Its Git identity could not be fully resolved, so T3 Code cannot confirm whether this root's own repository metadata is in use; no change to this root is implied."),
                });
              }
              break;
            }
            case "not-a-repository": {
              effectiveRootRepository = rootGitMarker;
              inGitWorkTree = rootGitMarker;
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

        // Applicability comes from the selected consumer/operation and from the
        // repository's own sparse-checkout configuration. OpenCode snapshot
        // staging passes `git add --all --sparse` for eligible files in ordinary
        // repositories too, so a missing `--sparse` is actionable for that
        // consumer. T3's own checkpoint path only needs it in a sparse checkout.
        // Resolve the repository-side applicability *before* the capability probe
        // so an incomplete probe is still recognized as relevant (W1-B): a
        // failure after a verified sparse checkout must warn, not be dropped.
        const requiredByConsumer = consumerUsesSparseAdd(input.consumer) && inGitWorkTree;
        const sparseConfigOutcome = yield* input.git
          .isSparseCheckout(input.root, input.gitEnvironment)
          .pipe(
            Effect.map((value) => ({ _tag: "ok" as const, value })),
            Effect.catch((error) => Effect.succeed({ _tag: "error" as const, error })),
            Effect.timeoutOption(GIT_PROBE_TIMEOUT),
            Effect.map(Option.getOrElse(() => ({ _tag: "timeout" as const }))),
          );
        // A verified sparse checkout makes the capability relevant for every
        // consumer. When the config check itself is incomplete, only the
        // consumer-derived requirement is known; the repository side stays
        // unknown rather than assumed.
        const sparseCheckoutVerified =
          sparseConfigOutcome._tag === "ok" && sparseConfigOutcome.value;
        const sparseApplicable = requiredByConsumer || sparseCheckoutVerified;
        if (sparseApplicable) {
          const sparseOutcome = yield* input.git
            .probeSparseAdd(input.root, input.gitEnvironment)
            .pipe(
              Effect.map((state) => ({ _tag: "ok" as const, state })),
              Effect.catch((error) => Effect.succeed({ _tag: "error" as const, error })),
              Effect.timeoutOption(GIT_PROBE_TIMEOUT),
              Effect.map(Option.getOrElse(() => ({ _tag: "timeout" as const }))),
            );
          if (sparseOutcome._tag === "ok" && sparseOutcome.state === "unsupported") {
            yield* add({
              code: "git-sparse-add-unsupported",
              severity: "warning",
              message: requiredByConsumer
                ? "The selected OpenCode session snapshots this repository with `git add --sparse`, but the " +
                  "Git this launch resolves does not support `--sparse`. Staging changed and untracked files " +
                  "for a snapshot will fail, so snapshots may be incomplete. Install a newer Git (or disable " +
                  "OpenCode snapshots) to keep snapshots accurate; the session can still start."
                : "This is a sparse Git checkout, but the Git this launch resolves does not support " +
                  "`git add --sparse`. T3 Code cannot tell which files the sparse rules exclude, so a " +
                  "checkpoint may record excluded files as deleted. Install a newer Git to keep sparse " +
                  "checkpoints accurate; the session can still start.",
            });
          } else if (sparseOutcome._tag === "timeout") {
            // The capability is relevant and could not be confirmed. Report it as
            // incomplete rather than silently clean; never mislabel an unknown
            // capability as unsupported, and never block.
            yield* add({
              code: "git-probe-timed-out",
              severity: "warning",
              message:
                "The Git `add --sparse` capability probe did not finish in time, so this launch could not " +
                "be confirmed to support `git add --sparse`. Snapshots or sparse checkpoints may be " +
                "incomplete; the session can still start. Check the Git install and the session-root " +
                "filesystem.",
            });
          } else if (sparseOutcome._tag === "error") {
            yield* add({
              code: "git-probe-failed",
              severity: "warning",
              message:
                `The Git \`add --sparse\` capability probe failed (${sparseOutcome.error.detail}), so this ` +
                "launch could not be confirmed to support `git add --sparse`. Snapshots or sparse " +
                "checkpoints may be incomplete; the session can still start.",
            });
          }
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
        const outcome = yield* existsOutcome(candidate);
        if (outcome.state === "present") {
          readTarget = candidate;
          break;
        }
        if (outcome.state === "unknown") {
          // A denied or stalled metadata read is not absence. Report it once and
          // stop scanning further optional candidates; missing optional files
          // stay silent.
          yield* add(rootMetadataWarning(candidate, outcome.reason));
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
    // collected survive a mid-probe timeout, so an incomplete preflight is never
    // reported clean; each probe is still individually bounded above.
    const completed = Option.isSome(yield* explore.pipe(Effect.timeoutOption(TOTAL_PROBE_BUDGET)));
    if (!completed) {
      yield* add({
        code: "git-probe-timed-out",
        severity: "warning",
        message:
          "The launch preflight did not finish within its budget, so its checks are incomplete. " +
          "The session can still start; check the Git install and the session-root filesystem.",
      });
    }

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
      options?: {
        readonly isSharedRoot?: boolean;
        readonly configuredRoot?: string;
        readonly consumer?: LaunchPreflightConsumer;
        readonly gitEnvironment?: NodeJS.ProcessEnv;
      },
    ) => Effect.Effect<LaunchPreflightResult>;
  }
>()("t3/environment/LaunchPreflight") {}

/** Builds the production Git probe from the shared bounded VCS process runner. */
export const makeGitProbe = (
  vcsProcess: VcsProcess.VcsProcess["Service"],
  path: Path.Path,
): LaunchPreflightGitProbe => {
  const runGit = (
    operation: string,
    root: string,
    args: ReadonlyArray<string>,
    allowNonZeroExit: boolean,
    env?: NodeJS.ProcessEnv,
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
        ...(env !== undefined ? { env } : {}),
      })
      .pipe(Effect.mapError(classifyGitProbeError));

  return {
    version: (root, env) =>
      runGit("launch-preflight.git-version", root, ["--version"], false, env).pipe(
        Effect.map((result) => parseGitVersion(result.stdout) ?? parseGitVersion(result.stderr)),
      ),
    resolveIdentity: (root, env) =>
      Effect.gen(function* () {
        const top = yield* runGit(
          "launch-preflight.git-toplevel",
          root,
          ["rev-parse", "--show-toplevel"],
          true,
          env,
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
          env,
        );
        const rawCommonDir = Number(commonResult.exitCode) === 0 ? commonResult.stdout.trim() : "";
        // Plain `git rev-parse --git-common-dir` prints a path relative to the
        // directory Git actually ran in (the invocation cwd), e.g. `repo/sub`
        // yields `../.git`. Resolve against the exact invocation cwd `root`,
        // not the top level, or an ordinary subdirectory launch would resolve
        // to a path outside the repository. Absolute output is untouched.
        const commonDir =
          rawCommonDir.length > 0
            ? path.isAbsolute(rawCommonDir)
              ? rawCommonDir
              : path.resolve(root, rawCommonDir)
            : null;
        return {
          state: "ok",
          topLevel: topLevel.length > 0 ? topLevel : null,
          commonDir,
          detail: "",
        } satisfies LaunchPreflightRepoIdentity;
      }),
    isSparseCheckout: (root, env) =>
      Effect.gen(function* () {
        // Read-only: is the root repository actually a sparse checkout?
        const sparseConfig = yield* runGit(
          "launch-preflight.git-sparse-config",
          root,
          ["config", "--bool", "core.sparseCheckout"],
          true,
          env,
        );
        return Number(sparseConfig.exitCode) === 0 && sparseConfig.stdout.trim() === "true";
      }),
    probeSparseAdd: (root, env) =>
      Effect.gen(function* () {
        // Read-only usage probe; `git add -h` never stages a file.
        const help = yield* runGit(
          "launch-preflight.git-sparse-add-help",
          root,
          ["add", "-h"],
          true,
          env,
        );
        return /--(?:\[no-\])?sparse\b/.test(`${help.stdout}${help.stderr}`)
          ? ("supported" satisfies LaunchPreflightSparseCapability)
          : ("unsupported" satisfies LaunchPreflightSparseCapability);
      }),
  };
};

/** @public Service construction is part of the canonical Effect module API. */
export const makeFileProbe = (
  fileSystem: FileSystem.FileSystem,
): LaunchPreflightFileProbe => ({
  // Reuse the typed stat/absence distinction: a genuine NotFound is the only
  // state that means "absent". A denied or I/O-failed lookup stays a probe
  // error so the caller warns instead of reading it as absence.
  exists: (target) =>
    fileSystem.stat(target).pipe(
      Effect.as(true),
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed(false),
      ),
      Effect.mapError(
        (cause) => new LaunchPreflightProbeError({ reason: "failed", detail: String(cause) }),
      ),
    ),
  stat: (target) =>
    fileSystem.stat(target).pipe(
      Effect.map((entry): LaunchPreflightFsEntry => ({
        type: entry.type === "Directory" ? "directory" : entry.type === "File" ? "file" : "other",
      })),
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed({ type: "missing" } satisfies LaunchPreflightFsEntry),
      ),
      Effect.mapError(
        (cause) => new LaunchPreflightProbeError({ reason: "failed", detail: String(cause) }),
      ),
    ),
  realPath: (target) => fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => null)),
  readFirstBytes: (target, maxBytes) =>
    fileSystem.stream(target, { bytesToRead: maxBytes }).pipe(
      Stream.runCount,
      Effect.mapError(
        (cause) => new LaunchPreflightProbeError({ reason: "failed", detail: String(cause) }),
      ),
    ),
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = makeGitProbe(vcsProcess, path);
  const files = makeFileProbe(fileSystem);

  return LaunchPreflight.of({
    run: (root: string, options) =>
      runLaunchPreflight({
        root,
        git,
        files,
        ...(options?.isSharedRoot !== undefined ? { isSharedRoot: options.isSharedRoot } : {}),
        ...(options?.configuredRoot !== undefined ? { configuredRoot: options.configuredRoot } : {}),
        ...(options?.consumer !== undefined ? { consumer: options.consumer } : {}),
        ...(options?.gitEnvironment !== undefined
          ? { gitEnvironment: options.gitEnvironment }
          : {}),
      }).pipe(Effect.provideService(Path.Path, path)),
  });
});

export const layer = Layer.effect(LaunchPreflight, make);
