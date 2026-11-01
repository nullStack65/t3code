/**
 * In-memory hand-off for launch-preflight warnings found before any provider
 * session exists.
 *
 * The startup preflight runs while no thread is available, so its findings can
 * only be logged there. This inbox carries them to the first provider session
 * in the same working directory, which delivers them through the existing
 * thread-activity warning transport — the same one a live launch uses. It is a
 * process-scoped `Context.Reference` (like the shell command-resolution cache),
 * never persisted, and not a dashboard or a store.
 *
 * Delivery is peek-then-clear: a pending notice is removed only after it was
 * actually delivered, so a transient delivery failure does not silently discard
 * a warning. The per-directory list is bounded so a long-running server cannot
 * accumulate unbounded pending notices.
 *
 * @module LaunchPreflightWarningInbox
 */
import * as Context from "effect/Context";

import type { LaunchPreflightFindingCode } from "./LaunchPreflight.ts";

export interface PendingLaunchPreflightWarning {
  readonly code: LaunchPreflightFindingCode;
  readonly message: string;
}

/** Cap on pending notices retained per working directory. */
const LAUNCH_PREFLIGHT_INBOX_LIMIT = 16;

export const LaunchPreflightWarningInbox = Context.Reference<
  Map<string, ReadonlyArray<PendingLaunchPreflightWarning>>
>("@t3tools/server/LaunchPreflightWarningInbox", {
  defaultValue: () => new Map(),
});

/**
 * Records startup findings under an already-normalized working directory,
 * bounded to {@link LAUNCH_PREFLIGHT_INBOX_LIMIT} notices per directory.
 */
export const recordLaunchPreflightWarnings = (
  inbox: Map<string, ReadonlyArray<PendingLaunchPreflightWarning>>,
  normalizedCwd: string,
  warnings: ReadonlyArray<PendingLaunchPreflightWarning>,
): void => {
  if (warnings.length === 0) return;
  const combined = [...(inbox.get(normalizedCwd) ?? []), ...warnings];
  inbox.set(
    normalizedCwd,
    combined.length > LAUNCH_PREFLIGHT_INBOX_LIMIT
      ? combined.slice(combined.length - LAUNCH_PREFLIGHT_INBOX_LIMIT)
      : combined,
  );
};

/**
 * Reads pending findings for an already-normalized directory without removing
 * them. Call {@link clearLaunchPreflightWarnings} only after successful delivery.
 */
export const peekLaunchPreflightWarnings = (
  inbox: Map<string, ReadonlyArray<PendingLaunchPreflightWarning>>,
  normalizedCwd: string,
): ReadonlyArray<PendingLaunchPreflightWarning> => inbox.get(normalizedCwd) ?? [];

/**
 * Removes pending findings for an already-normalized directory after they were
 * delivered. Anything still undelivered must be passed in `keep` so it survives
 * to the next session in the same directory.
 */
export const clearLaunchPreflightWarnings = (
  inbox: Map<string, ReadonlyArray<PendingLaunchPreflightWarning>>,
  normalizedCwd: string,
  keep: ReadonlyArray<PendingLaunchPreflightWarning> = [],
): void => {
  if (keep.length === 0) {
    inbox.delete(normalizedCwd);
    return;
  }
  inbox.set(normalizedCwd, keep);
};
