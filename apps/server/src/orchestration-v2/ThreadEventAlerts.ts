import {
  type EnvironmentId,
  isListedThreadLineage,
  isDelegatedAppThread,
  ModelAlertWatcher,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

/**
 * Deterministic thread events for the watcher thread, judged from a thread's shell with no agent
 * judgment. Delivery, retry and dedupe live in ModelAlertReactor, which carries these beside its
 * model alerts.
 */
export const ThreadEventKind = Schema.Literals([
  "lane-ended",
  "thread-failed",
  "promise-without-wake",
  "stuck",
  "needs-person",
]);
export type ThreadEventKind = typeof ThreadEventKind.Type;

export const ThreadEventAlert = Schema.Struct({
  type: Schema.Literal("thread-event"),
  kind: ThreadEventKind,
  id: Schema.String,
  environmentId: Schema.String,
  environmentLabel: Schema.String,
  threadId: Schema.String,
  threadTitle: Schema.String,
  threadLink: Schema.String,
  runId: Schema.NullOr(Schema.String),
  /** What happened, in a sentence: how the run ended, what is missing, what is waiting. */
  detail: Schema.String,
  lastAssistantLine: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  openPullRequests: Schema.Array(Schema.String),
  occurredAt: Schema.String,
  recipient: Schema.optionalKey(ModelAlertWatcher),
});
export type ThreadEventAlert = typeof ThreadEventAlert.Type;

/** What made the server look at a thread; each trigger judges only the kinds it can change. */
export type ThreadEventTrigger = "run-ended" | "settled" | "inbox" | "request" | "sweep";

const KINDS_BY_TRIGGER: Record<ThreadEventTrigger, ReadonlyArray<ThreadEventKind>> = {
  "run-ended": ["lane-ended", "thread-failed", "promise-without-wake"],
  settled: ["promise-without-wake"],
  inbox: ["needs-person"],
  request: ["needs-person"],
  sweep: ["stuck"],
};

export type WatchedShell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "title"
  | "createdBy"
  | "lineage"
  | "delegatedFrom"
  | "inbox"
  | "status"
  | "activeRunId"
  | "latestRunId"
  | "latestRunCompletedAt"
  | "latestRunStopRequested"
  | "activityRunStatus"
  | "blockedOnThreadWait"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
  | "pullRequests"
  | "latestVisibleMessage"
  | "lastError"
  | "settledOverride"
  | "archivedAt"
  | "snoozedUntil"
  | "limitRecovery"
  | "updatedAt"
>;

export interface ThreadFinding {
  readonly kind: ThreadEventKind;
  readonly detail: string;
  /** The state the finding describes; the same one reports once, a different one reports again. */
  readonly signature: string;
}

/** A run that ended longer ago than this is history, not news, whatever woke the judge. */
const RECENT_RUN_END_MS = 15 * 60 * 1000;

const timeMs = (value: DateTime.Utc | null | undefined) =>
  value === null || value === undefined ? null : DateTime.toEpochMillis(value);

const isLive = (shell: WatchedShell) =>
  shell.activeRunId !== null || (shell.activityRunStatus ?? null) !== null;

const openPullRequests = (shell: WatchedShell) =>
  visibleThreadPullRequests(shell.pullRequests ?? []).filter(
    (link) => link.snapshot === null || link.snapshot.state === "open",
  );

/** A pending task, a watching PR, a delegated task or a snooze that will bring the thread back. */
function hasWakeHandle(shell: WatchedShell, remoteTaskCount: number, nowMs: number) {
  if ((shell.pendingBackgroundTasks ?? []).length > 0) return true;
  if (remoteTaskCount > 0) return true;
  if ((shell.pullRequests ?? []).some((link) => link.watch !== undefined)) return true;
  if (shell.limitRecovery?.autoResume === true || shell.limitRecovery?.snooze === true) return true;
  const snoozedUntil = timeMs(shell.snoozedUntil);
  return snoozedUntil !== null && snoozedUntil > nowMs;
}

/**
 * Phrases an agent uses to say something will wake it or that it will carry on later. An explicit
 * list on purpose: a false alarm costs a Lead turn, and the agent can always avoid the phrase by
 * registering a real wait.
 */
const PROMISE_PHRASES: ReadonlyArray<RegExp> = [
  /\bwill (?:wake|notify|ping|resume) (?:this|the|me|it|my)\b/i,
  /\bwill (?:be )?woken\b/i,
  /\bI(?:'ll| will) be (?:woken|notified|pinged)\b/i,
  /\b(?:watch|monitor|task|job|timer|check)\b[^.\n]{0,40}\bwill (?:wake|resume|notify)\b/i,
  /\bI(?:'ll| will) (?:install|merge|continue|resume|finish|roll(?: it)? out|deploy|pick (?:this|it) (?:back )?up|check|come back)\b[^.\n]{0,80}\b(?:after|once|when|as soon as|later)\b/i,
  /\b(?:keeping|keep|leaving|leave|holding|hold) (?:this|the) (?:lane|thread) open\b/i,
  /\bwill (?:continue|resume|carry on) (?:when|once|after|later)\b/i,
];

export const promisesToContinue = (text: string) =>
  PROMISE_PHRASES.some((phrase) => phrase.test(text));

/** The last non-empty line of a message, trimmed to keep a wake short. */
export function lastLine(text: string, max = 240): string | null {
  const line = text
    .split("\n")
    .map((candidate) => candidate.trim())
    .findLast((candidate) => candidate.length > 0);
  if (line === undefined) return null;
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

const IDLE_STATUSES = new Set<string>(["idle", "completed"]);
const STRANDED_QUEUE_MS = 15 * 60_000;

export interface StrandedQueue {
  readonly runId: string;
  readonly requestedAt: DateTime.Utc;
  readonly lastCompletedAt?: DateTime.Utc | null;
  readonly queueHeld?: boolean;
}

const strandedQueueSignature = (queue: StrandedQueue) => `stranded-queue:${queue.runId}`;
export const isStrandedQueueSignature = (signature: string) =>
  signature.startsWith("stranded-queue:");

export function keepStrandedQueueReport(
  signature: string,
  queue: StrandedQueue | null | undefined,
) {
  return (
    isStrandedQueueSignature(signature) &&
    (queue === undefined || (queue !== null && signature === strandedQueueSignature(queue)))
  );
}

/**
 * Which of the trigger's kinds are true of the thread right now. `evaluated` lists every kind the
 * trigger can judge, so a kind that is no longer true can reset its dedupe.
 */
export function judgeThread(input: {
  readonly shell: WatchedShell;
  readonly trigger: ThreadEventTrigger;
  readonly nowMs: number;
  readonly stuckMinutes: number;
  readonly strandedQueue?: StrandedQueue | null;
  /** Open delegated tasks on a linked environment, which the shell does not list. */
  readonly remoteTaskCount?: number;
  /** The latest activity among the children this thread waits on. */
  readonly childActivityMs?: number | null;
  readonly hasStalenessWait?: boolean;
  /** A model alert for the run already reported a usage limit, so a failure adds nothing. */
  readonly usageLimitReported?: boolean;
}): { readonly evaluated: ReadonlyArray<ThreadEventKind>; readonly findings: ThreadFinding[] } {
  const { shell, nowMs } = input;
  const evaluated = KINDS_BY_TRIGGER[input.trigger];
  const findings: ThreadFinding[] = [];
  // Only a top-level lane an agent runs, that nobody has archived or settled, is worth waking the
  // watcher for. A person's own thread ending, stopping or going quiet is not news.
  const watched =
    shell.createdBy === "agent" &&
    isListedThreadLineage(shell.lineage) &&
    shell.archivedAt === null &&
    shell.settledOverride !== "settled";
  const remoteTaskCount = input.remoteTaskCount ?? 0;
  const tasks = shell.pendingBackgroundTasks ?? [];

  if (evaluated.includes("lane-ended") && watched && !isLive(shell)) {
    const endedMs = timeMs(shell.latestRunCompletedAt);
    const recent = endedMs !== null && nowMs - endedMs <= RECENT_RUN_END_MS;
    const prs = openPullRequests(shell);
    if (recent && shell.latestRunId !== null) {
      if (
        (shell.status === "failed" && input.usageLimitReported !== true) ||
        shell.status === "interrupted"
      ) {
        findings.push({
          kind: "lane-ended",
          detail: `its last run ${shell.status}`,
          signature: shell.latestRunId,
        });
      } else if (
        shell.status === "completed" &&
        prs.length > 0 &&
        !hasWakeHandle(shell, remoteTaskCount, nowMs)
      ) {
        findings.push({
          kind: "lane-ended",
          detail: `its last run completed with ${prs.length} open pull request${prs.length === 1 ? "" : "s"} and nothing tracked that will wake it`,
          signature: shell.latestRunId,
        });
      }
    }
  }

  if (
    evaluated.includes("thread-failed") &&
    shell.status === "failed" &&
    input.usageLimitReported !== true &&
    launchingThreadId(shell.inbox) === null &&
    shell.latestRunId !== null &&
    !isLive(shell) &&
    shell.lineage.parentThreadId === null &&
    isListedThreadLineage(shell.lineage) &&
    !isDelegatedAppThread(shell) &&
    shell.archivedAt === null &&
    shell.settledOverride !== "settled"
  ) {
    findings.push({
      kind: "thread-failed",
      detail: "its last run failed",
      signature: shell.latestRunId,
    });
  }

  if (evaluated.includes("promise-without-wake") && watched && !isLive(shell)) {
    const message = shell.latestVisibleMessage;
    const endedMs = timeMs(shell.latestRunCompletedAt);
    const recent =
      input.trigger === "settled" || (endedMs !== null && nowMs - endedMs <= RECENT_RUN_END_MS);
    if (
      recent &&
      IDLE_STATUSES.has(shell.status) &&
      message?.role === "assistant" &&
      promisesToContinue(message.text) &&
      !hasWakeHandle(shell, remoteTaskCount, nowMs) &&
      shell.pendingRuntimeRequest === null &&
      shell.inbox?.decisionRequest === undefined
    ) {
      findings.push({
        kind: "promise-without-wake",
        detail:
          "its last message says it will be woken or will continue later, but nothing tracked will wake it",
        signature: message.id,
      });
    }
  }

  const queue = input.strandedQueue;
  const queueWaitMs =
    queue == null
      ? 0
      : nowMs -
        Math.max(
          DateTime.toEpochMillis(queue.requestedAt),
          timeMs(queue.lastCompletedAt ?? shell.latestRunCompletedAt) ?? 0,
        );
  if (
    evaluated.includes("stuck") &&
    watched &&
    queue != null &&
    queue.queueHeld !== true &&
    !isLive(shell) &&
    shell.latestRunStopRequested !== true &&
    shell.pendingRuntimeRequest === null &&
    shell.inbox?.decisionRequest === undefined &&
    (timeMs(shell.snoozedUntil) ?? 0) <= nowMs &&
    shell.limitRecovery?.autoResume !== true &&
    queueWaitMs > STRANDED_QUEUE_MS
  ) {
    findings.push({
      kind: "stuck",
      detail: `it has queued work without an active run for ${Math.floor(queueWaitMs / 60_000)} minutes`,
      signature: strandedQueueSignature(queue),
    });
  }

  if (evaluated.includes("stuck") && watched && input.stuckMinutes > 0) {
    const activityMs = Math.max(timeMs(shell.updatedAt) ?? 0, input.childActivityMs ?? 0);
    const quietMinutes = Math.floor((nowMs - activityMs) / 60_000);
    const quiet = activityMs > 0 && quietMinutes >= input.stuckMinutes;
    const waiting = shell.activityRunStatus === "waiting" || shell.status === "waiting";
    if (quiet && waiting) {
      // A wait the shell still shows, with nothing behind it that could end it.
      if (
        tasks.length === 0 &&
        remoteTaskCount === 0 &&
        shell.pendingRuntimeRequest === null &&
        !(shell.pullRequests ?? []).some((link) => link.watch !== undefined)
      ) {
        findings.push({
          kind: "stuck",
          detail: `it has waited ${quietMinutes} minutes on background work that no longer exists`,
          signature: `${shell.latestRunId ?? shell.id}:orphan-wait`,
        });
      }
    } else if (
      quiet &&
      shell.activeRunId !== null &&
      shell.blockedOnThreadWait !== true &&
      input.hasStalenessWait !== true &&
      shell.pendingRuntimeRequest === null
    ) {
      findings.push({
        kind: "stuck",
        detail: `its run is active with no new activity for ${quietMinutes} minutes`,
        signature: shell.activeRunId,
      });
    }
  }

  if (evaluated.includes("needs-person") && watched) {
    const request = shell.pendingRuntimeRequest;
    const inbox = shell.inbox;
    if (request !== null) {
      findings.push({
        kind: "needs-person",
        detail: `it is waiting on ${request.userOnly === true ? "a secret or link only the user can give" : `a ${request.kind.replaceAll("_", " ")}`}`,
        signature: `request:${request.id}`,
      });
    }
    const founderAssignee = inbox?.assignee?.kind === "human" ? inbox.assignee.id : null;
    if (inbox !== undefined && (founderAssignee !== null || inbox.attentionKind === "action")) {
      const ask = inbox.decisionRequest;
      findings.push({
        kind: "needs-person",
        detail: [
          founderAssignee === null
            ? "its inbox attention is set to action"
            : `its inbox is assigned to ${founderAssignee}`,
          ask === undefined ? null : `with an open ${ask.kind}: ${ask.question}`,
          ask === undefined && inbox.reason !== undefined ? `for ${inbox.reason}` : null,
        ]
          .filter((part) => part !== null)
          .join(" "),
        signature: `inbox:${founderAssignee ?? ""}:${inbox.attentionKind}:${ask?.requestedAt ?? ""}`,
      });
    }
  }

  return { evaluated, findings };
}

export const launchingThreadId = (inbox: WatchedShell["inbox"]) =>
  [inbox?.origin, inbox?.requestedBy].find((actor) => actor?.kind === "agent")?.id ?? null;

export function threadEventAlert(input: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly shell: Pick<
    WatchedShell,
    | "id"
    | "title"
    | "latestRunId"
    | "latestVisibleMessage"
    | "lastError"
    | "pullRequests"
    | "activeRunId"
  >;
  readonly finding: ThreadFinding;
  readonly occurredAt: string;
  readonly recipient: ModelAlertWatcher | null;
}): ThreadEventAlert {
  const { shell, finding } = input;
  const message = shell.latestVisibleMessage;
  return {
    type: "thread-event",
    kind: finding.kind,
    // The time makes each occurrence its own message: the delivery key hashes this id, and a
    // recurrence of the same state must not be taken for a replay of the first.
    id: `${input.environmentId}:${shell.id}:${finding.kind}:${finding.signature}${finding.kind === "thread-failed" ? "" : `:${input.occurredAt}`}`,
    environmentId: input.environmentId,
    environmentLabel: input.environmentLabel,
    threadId: shell.id,
    threadTitle: shell.title,
    threadLink: formatThreadLink(
      { environmentId: input.environmentId, threadId: shell.id },
      shell.title,
    ),
    runId: shell.activeRunId ?? shell.latestRunId,
    detail: finding.detail,
    lastAssistantLine:
      finding.kind !== "thread-failed" && message?.role === "assistant"
        ? lastLine(message.text)
        : null,
    lastError:
      shell.lastError === null || shell.lastError === undefined ? null : lastLine(shell.lastError),
    openPullRequests: openPullRequests({ pullRequests: shell.pullRequests } as WatchedShell)
      .map((link) => link.url)
      .slice(0, 5),
    occurredAt: input.occurredAt,
    ...(input.recipient === null ? {} : { recipient: input.recipient }),
  };
}

/** The trigger that judges each kind again at delivery: any trigger whose kinds include it. */
export const REJUDGE_TRIGGER: Record<ThreadEventKind, ThreadEventTrigger> = {
  "thread-failed": "run-ended",
  "lane-ended": "run-ended",
  "promise-without-wake": "settled",
  stuck: "sweep",
  "needs-person": "request",
};

/**
 * Whether a queued thread event is still true of the thread as it stands now, judged at the time it
 * fired so the recent-run window does not expire while delivery waits. A lane that restarted,
 * settled, registered a wait, merged its pull request or got its answer since then is no news.
 */
export function threadEventStillHolds(input: {
  readonly alert: ThreadEventAlert;
  readonly shell: WatchedShell;
  readonly stuckMinutes: number;
  readonly strandedQueue?: StrandedQueue | null;
  readonly remoteTaskCount?: number;
  readonly childActivityMs?: number | null;
  readonly hasStalenessWait?: boolean;
}): boolean {
  const { alert } = input;
  const firedMs = Date.parse(alert.occurredAt);
  if (!Number.isFinite(firedMs)) return true;
  const { findings } = judgeThread({
    ...(input.hasStalenessWait === undefined ? {} : { hasStalenessWait: input.hasStalenessWait }),
    shell: input.shell,
    trigger: REJUDGE_TRIGGER[alert.kind],
    nowMs: firedMs,
    stuckMinutes: input.stuckMinutes,
    ...(input.strandedQueue === undefined ? {} : { strandedQueue: input.strandedQueue }),
    ...(input.remoteTaskCount === undefined ? {} : { remoteTaskCount: input.remoteTaskCount }),
    ...(input.childActivityMs === undefined ? {} : { childActivityMs: input.childActivityMs }),
  });
  const prefix = `${alert.environmentId}:${alert.threadId}:${alert.kind}:`;
  return findings.some(
    (finding) =>
      finding.kind === alert.kind &&
      (alert.kind === "thread-failed"
        ? alert.runId === finding.signature
        : alert.id === `${prefix}${finding.signature}:${alert.occurredAt}`),
  );
}

const NEXT_STEP: Record<ThreadEventKind, string> = {
  "thread-failed": "Triage the failed run. Check its retry history before taking action.",
  "lane-ended":
    "Check the thread: restart, repair or replace it, or settle it if its work is done. It sends no further alert for this run.",
  "promise-without-wake":
    "Tell the thread to register a real wait (a tracked background command, a PR watch or a delegate) and carry on, or finish the work yourself.",
  stuck:
    "Read the thread. Interrupt and restart it, or replace it. It sends no further alert for this run.",
  "needs-person":
    "Try to clear it yourself first: answer from what you know, approve what Kameron already authorized, or delegate it. Raise it to a founder only if it needs a passkey, a phone prompt, physical presence or new spend.",
};

export function threadEventMessage(alert: ThreadEventAlert): string {
  return [
    `Thread event from ${alert.environmentLabel} (environment ${alert.environmentId}): ${alert.threadLink} ${alert.detail}.`,
    [
      `Event: ${alert.kind}.`,
      alert.runId === null ? null : `Run ${alert.runId}.`,
      alert.openPullRequests.length === 0
        ? "No open pull requests."
        : `Open pull requests: ${alert.openPullRequests.join(", ")}.`,
      alert.lastAssistantLine === null ? null : `Last assistant line: "${alert.lastAssistantLine}"`,
      alert.lastError === null ? null : `Last error: ${alert.lastError}`,
    ]
      .filter((part) => part !== null)
      .join(" "),
    NEXT_STEP[alert.kind],
  ].join("\n\n");
}
