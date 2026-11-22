import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function staleTimeoutMs(minutes: number | undefined, defaultMinutes: number): number {
  return Math.round(Math.max(5, Math.min(1440, minutes ?? defaultMinutes)) * 60_000);
}

export function waitActivityMs(shell: OrchestrationV2ThreadShell): number {
  const timestamp = (value: DateTime.Utc | null | undefined) =>
    value == null ? 0 : DateTime.toEpochMillis(value);
  return Math.max(
    timestamp(shell.latestRunRequestedAt),
    timestamp(shell.latestRunStartedAt),
    timestamp(shell.latestRunCompletedAt),
    shell.latestVisibleMessage?.role === "assistant"
      ? timestamp(shell.latestVisibleMessage.updatedAt)
      : 0,
  );
}

export function waitIntentionallyHeld(shell: OrchestrationV2ThreadShell, now: number): boolean {
  return (
    shell.pendingRuntimeRequest !== null ||
    shell.inbox?.decisionRequest !== undefined ||
    shell.latestRunStopRequested === true ||
    (shell.snoozedUntil != null && DateTime.toEpochMillis(shell.snoozedUntil) > now) ||
    shell.limitRecovery?.autoResume === true ||
    (shell.limitRecovery != null && Date.parse(shell.limitRecovery.resetAt) > now)
  );
}
