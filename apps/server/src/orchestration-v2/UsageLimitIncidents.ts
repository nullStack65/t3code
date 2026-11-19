import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

/**
 * One usage limit hits every thread on an account at once. The watcher hears one incident per
 * (provider account, outcome), the way Alertmanager groups by labels, not one turn per thread.
 * Delivery and state live in ModelAlertReactor.
 */
export const IncidentMember = Schema.Struct({
  threadId: Schema.String,
  threadTitle: Schema.String,
  threadLink: Schema.String,
  runId: Schema.String,
});
export type IncidentMember = typeof IncidentMember.Type;

export const UsageLimitIncident = Schema.Struct({
  type: Schema.Literal("usage-limit-incident"),
  /** Unique per queued item, so a later incident for the same group is a new message. */
  id: Schema.String,
  /** What merges: environment, provider account and outcome. */
  groupKey: Schema.String,
  environmentId: Schema.String,
  environmentLabel: Schema.String,
  providerInstanceId: Schema.String,
  /** False: the threads stopped at the limit. True: they did not come back after the reset. */
  resumeFailed: Schema.Boolean,
  resetAt: Schema.NullOr(Schema.String),
  members: Schema.Array(IncidentMember),
  occurredAt: Schema.String,
});
export type UsageLimitIncident = typeof UsageLimitIncident.Type;

export const incidentGroupKey = (input: {
  readonly environmentId: string;
  readonly providerInstanceId: string;
  readonly resumeFailed: boolean;
}) =>
  `${input.environmentId}:usage-limit${input.resumeFailed ? "-resume-failed" : ""}:${input.providerInstanceId}`;

const laterIso = (left: string | null, right: string | null) => {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
};

/** The incident with one more thread; a thread already in it keeps one row, at its newest run. */
export function withIncidentMember(
  incident: UsageLimitIncident,
  member: IncidentMember,
  resetAt: string | null,
): UsageLimitIncident {
  return {
    ...incident,
    resetAt: laterIso(incident.resetAt, resetAt),
    members: [...incident.members.filter((known) => known.threadId !== member.threadId), member],
  };
}

type StaleShell = Pick<
  OrchestrationV2ThreadShell,
  | "latestRunId"
  | "activeRunId"
  | "status"
  | "archivedAt"
  | "deletedAt"
  | "settledOverride"
  | "providerInstanceId"
>;

const LIVE_OR_DONE = new Set<string>(["preparing", "starting", "running", "waiting", "completed"]);

/**
 * Whether an alert about a run is out of date: the thread has a newer run that is running or
 * finished, or it is gone. A model alert is also out of date once the thread is settled or runs on
 * another provider. Checked when the alert is delivered, not when it was judged.
 */
export function alertIsStale(
  shell: StaleShell | null,
  runId: string | null,
  about?: { readonly providerInstanceId: string },
): boolean {
  if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) return true;
  if (about !== undefined) {
    if (shell.settledOverride === "settled") return true;
    if (shell.providerInstanceId !== about.providerInstanceId) return true;
  }
  if (runId === null || shell.latestRunId === runId) return false;
  return shell.activeRunId !== null || LIVE_OR_DONE.has(shell.status);
}

type SiblingShell = Pick<
  OrchestrationV2ThreadShell,
  "title" | "status" | "activeRunId" | "archivedAt" | "deletedAt"
>;

/**
 * A delegated child its parent replaced: a later sibling carries the same title, which is how
 * delegate_task names the task, and is itself running or finished. A sibling that also failed, or
 * is gone, replaces nothing: templated prompts share a title and each still needs its alert.
 */
export function replacedBySibling(
  child: { readonly title: string },
  later: ReadonlyArray<SiblingShell>,
): boolean {
  const title = child.title.trim().toLowerCase();
  return later.some(
    (sibling) =>
      sibling.title.trim().toLowerCase() === title &&
      sibling.archivedAt === null &&
      sibling.deletedAt === null &&
      (sibling.activeRunId !== null || LIVE_OR_DONE.has(sibling.status)),
  );
}

/** Whether the server will resume a thread by itself when its limit resets. */
export function expectsAutoResume(input: {
  readonly autoResumeEnabled: boolean;
  /** The run was already a resume after an earlier reset: a second failure is news. */
  readonly runWasResume: boolean;
  readonly shell: Pick<
    OrchestrationV2ThreadShell,
    | "usageLimitResetAt"
    | "archivedAt"
    | "settledOverride"
    | "pendingRuntimeRequest"
    | "snoozedUntil"
  > | null;
  /** The recovery worker never arms a delegated child whose parent is settled, archived or gone. */
  readonly parentClosed?: boolean;
  readonly nowMs: number;
  /** How long past the reset the thread may stay stopped before it counts as not resumed. */
  readonly graceMs?: number;
}): boolean {
  const { shell } = input;
  if (!input.autoResumeEnabled || input.runWasResume || shell === null) return false;
  if (shell.archivedAt !== null || shell.settledOverride === "settled") return false;
  if (shell.pendingRuntimeRequest !== null || input.parentClosed === true) return false;
  const resetMs =
    shell.usageLimitResetAt == null ? Number.NaN : Date.parse(shell.usageLimitResetAt);
  if (!Number.isFinite(resetMs) || resetMs <= input.nowMs - 60_000) return false;
  // The worker waits out a snooze, so one that outlasts the grace period means no resume in time.
  const snoozedMs = shell.snoozedUntil == null ? null : DateTime.toEpochMillis(shell.snoozedUntil);
  return snoozedMs === null || snoozedMs <= resetMs + (input.graceMs ?? 0);
}

const MAX_LISTED = 25;

export function incidentMessage(incident: UsageLimitIncident): string {
  const count = incident.members.length;
  const threads = `${count} thread${count === 1 ? "" : "s"}`;
  const reset =
    incident.resetAt === null
      ? "The reset time is not reported."
      : `It resets at ${incident.resetAt}.`;
  const lead = incident.resumeFailed
    ? `Usage limit incident on ${incident.providerInstanceId} (${incident.environmentLabel}, environment ${incident.environmentId}): ${threads} did not come back after the limit reset. ${reset}`
    : `Usage limit incident on ${incident.providerInstanceId} (${incident.environmentLabel}, environment ${incident.environmentId}): ${threads} stopped at the provider's usage limit. ${reset}`;
  const listed = incident.members
    .slice(0, MAX_LISTED)
    .map((member, index) => `${index + 1}. ${member.threadLink} (run ${member.runId})`);
  if (count > MAX_LISTED) listed.push(`...and ${count - MAX_LISTED} more.`);
  const next = incident.resumeFailed
    ? "Automatic resume did not work for these. Resume them yourself, switch their provider, or replace them. This is the only alert for this incident."
    : "Nothing was resumed automatically for these. Resume them after the reset, or switch their provider. This is the only alert for this incident; later threads that hit the same limit join a later digest.";
  return [lead, listed.join("\n"), next].join("\n\n");
}
