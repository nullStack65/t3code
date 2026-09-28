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
 * @module LaunchPreflightWarningInbox
 */
import * as Context from "effect/Context";

import type { LaunchPreflightFindingCode } from "./LaunchPreflight.ts";

export interface PendingLaunchPreflightWarning {
  readonly code: LaunchPreflightFindingCode;
  readonly message: string;
}

export const LaunchPreflightWarningInbox = Context.Reference<
  Map<string, ReadonlyArray<PendingLaunchPreflightWarning>>
>("@t3tools/server/LaunchPreflightWarningInbox", {
  defaultValue: () => new Map(),
});

/** Records startup findings under an already-normalized working directory. */
export const recordLaunchPreflightWarnings = (
  inbox: Map<string, ReadonlyArray<PendingLaunchPreflightWarning>>,
  normalizedCwd: string,
  warnings: ReadonlyArray<PendingLaunchPreflightWarning>,
): void => {
  if (warnings.length === 0) return;
  inbox.set(normalizedCwd, [...(inbox.get(normalizedCwd) ?? []), ...warnings]);
};

/** Takes (and clears) pending findings for an already-normalized directory. */
export const takeLaunchPreflightWarnings = (
  inbox: Map<string, ReadonlyArray<PendingLaunchPreflightWarning>>,
  normalizedCwd: string,
): ReadonlyArray<PendingLaunchPreflightWarning> => {
  const pending = inbox.get(normalizedCwd);
  if (pending === undefined) return [];
  inbox.delete(normalizedCwd);
  return pending;
};
