import {
  CommandId,
  type EventSubscription,
  type EnvironmentId,
  isListedThreadLineage,
  MessageId,
  type ModelAlertWatcher,
  type OrchestrationV2DigestCategory,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2WorkerAlertReason,
  OrchestratorMcpThreadSendResult,
  ThreadId,
} from "@t3tools/contracts";
import { runModelSignals, workerAlert } from "@t3tools/provider-core/server/subagentProjection";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as EventSubscriptionStore from "../persistence/EventSubscriptions.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ProviderExhaustion } from "./ProviderExhaustion.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { resolveWakeTarget } from "./RetiredThreadRedirect.ts";
import {
  cursorOf,
  planThreadSubscription,
  threadSelectorKey,
  withCursor,
} from "./eventSubscription.ts";
import {
  isStrandedQueueSignature,
  judgeThread,
  keepStrandedQueueReport,
  type StrandedQueue,
  threadEventAlert,
  launchingThreadId,
  ThreadEventAlert,
  type ThreadEventKind,
  threadEventMessage,
  REJUDGE_TRIGGER,
  threadEventStillHolds,
  type ThreadEventTrigger,
  type ThreadFinding,
} from "./ThreadEventAlerts.ts";
import {
  alertIsStale,
  expectsAutoResume,
  incidentGroupKey,
  incidentMessage,
  type IncidentMember,
  replacedBySibling,
  UsageLimitIncident,
  withIncidentMember,
} from "./UsageLimitIncidents.ts";

export const ModelAlert = Schema.Struct({
  type: Schema.Literal("model-degraded"),
  id: Schema.String,
  environmentId: Schema.String,
  environmentLabel: Schema.String,
  threadId: Schema.String,
  threadTitle: Schema.String,
  threadLink: Schema.String,
  parentThreadId: Schema.NullOr(Schema.String),
  runId: Schema.String,
  runStatus: Schema.String,
  providerInstanceId: Schema.String,
  selectedModel: Schema.String,
  executedModel: Schema.NullOr(Schema.String),
  fallbackModels: Schema.Array(Schema.String),
  reasons: Schema.Array(OrchestrationV2WorkerAlertReason),
  occurredAt: Schema.String,
});
export type ModelAlert = typeof ModelAlert.Type;

/** A link from this environment that could not renew its credential, so it will stop working. */
export const PeerLinkRenewalAlert = Schema.Struct({
  type: Schema.Literal("peer-link-renewal"),
  id: Schema.String,
  environmentId: Schema.String,
  environmentLabel: Schema.String,
  linkedEnvironmentId: Schema.String,
  linkedLabel: Schema.String,
  /**
   * Names the link's session here (its secret store entry, never the credential), so linking
   * again starts a fresh alert rather than inheriting the old link's.
   */
  linkSession: Schema.String,
  /** When the link stops working, or stopped. */
  expiresAt: Schema.String,
  /** Why the last renewal failed. */
  detail: Schema.String,
  occurredAt: Schema.String,
});
export type PeerLinkRenewalAlert = typeof PeerLinkRenewalAlert.Type;

/** Everything the watcher thread hears: model alerts, thread events, usage limit incidents and links. */
export const WatcherAlert = Schema.Union([
  ModelAlert,
  ThreadEventAlert,
  UsageLimitIncident,
  PeerLinkRenewalAlert,
]);
export type WatcherAlert = typeof WatcherAlert.Type;

const Destination = Schema.Literals(["watcher", "webhook"]);
type Destination = typeof Destination.Type;

const Delivery = Schema.Struct({
  destination: Destination,
  alert: WatcherAlert,
  attempts: Schema.Int,
  nextAttemptAt: Schema.Number,
  createdAt: Schema.Number,
  /**
   * When the digest expires, fixed when the alert is queued. A retry must carry the same time,
   * or the first send and the retry disagree and the retry is not a replay.
   */
  digestExpiresAt: Schema.optional(Schema.Number),
});
type Delivery = typeof Delivery.Type;

export const ModelAlertState = Schema.Struct({
  version: Schema.Literal(1),
  /** The alert signature each thread last reported; a healthy run clears it. */
  degraded: Schema.Record(Schema.String, Schema.String),
  /** The signature of each thread event last reported, by thread and kind; a changed state clears it. */
  reported: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /**
   * Threads that hit a usage limit the server will resume at the reset. Lead hears of one only if
   * it fails to come back.
   */
  resuming: Schema.Record(
    Schema.String,
    Schema.Struct({ runId: Schema.String, resetAt: Schema.String, since: Schema.Number }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /** When each incident group last reached its destination, so later members wait a group interval. */
  incidentSentAt: Schema.Record(Schema.String, Schema.Number).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  failureWakeSentAt: Schema.Record(Schema.String, Schema.Number).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  outbox: Schema.Array(Delivery),
});
export type ModelAlertState = typeof ModelAlertState.Type;

export const EMPTY_MODEL_ALERT_STATE: ModelAlertState = {
  version: 1,
  degraded: {},
  reported: {},
  resuming: {},
  incidentSentAt: {},
  failureWakeSentAt: {},
  outbox: [],
};

const MAX_DEGRADED_THREADS = 1_000;
const MAX_REPORTED = 2_000;
const FAILURE_WAKE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_OUTBOX = 200;
const MAX_RESUMING = 2_000;
const MAX_INCIDENT_GROUPS = 200;
/** New incident members wait this long for the rest of the storm before the digest goes out. */
export const INCIDENT_GROUP_WAIT_MS = 30_000;
/** A group that just reported waits this long before it reports its stragglers. */
export const INCIDENT_GROUP_INTERVAL_MS = 5 * 60 * 1000;
/** How long past its reset a resumable thread may stay stopped before Lead hears it did not come back. */
export const RESUME_GRACE_MS = 30 * 60 * 1000;
const HOLD_RECHECK_MS = 5 * 60 * 1000;
const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 15 * 60 * 1000;

/** A run's model alert, or whether it finished cleanly and so shows the thread healthy again. */
export function modelAlertFor(input: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "id" | "title" | "lineage">;
  readonly run: OrchestrationV2Run;
  readonly projection: Pick<OrchestrationV2ThreadProjection, "turnItems" | "providerTurns">;
  readonly occurredAt: string;
}): { readonly alert: ModelAlert | undefined; readonly healthy: boolean } {
  const { run, thread } = input;
  const signals = runModelSignals(input.projection, run);
  // The task-withholding heuristic is for a parent judging its worker, not for a model alert.
  const reasons = workerAlert({ ...signals, finalText: undefined })?.reasons;
  if (reasons === undefined) {
    return { alert: undefined, healthy: run.status === "completed" };
  }
  return {
    healthy: false,
    alert: {
      type: "model-degraded",
      id: `${input.environmentId}:${run.id}`,
      environmentId: input.environmentId,
      environmentLabel: input.environmentLabel,
      threadId: thread.id,
      threadTitle: thread.title,
      threadLink: formatThreadLink(
        { environmentId: input.environmentId, threadId: thread.id },
        thread.title,
      ),
      parentThreadId: thread.lineage.parentThreadId,
      runId: run.id,
      runStatus: run.status,
      providerInstanceId: run.providerInstanceId,
      selectedModel: run.modelSelection.model,
      executedModel: signals.executedModel ?? null,
      fallbackModels: [...new Set(signals.fallbackModels)],
      reasons,
      occurredAt: input.occurredAt,
    },
  };
}

/** Where a thread's alert goes. A delegated child's parent hears it with its result already. */
export function modelAlertDestinations(input: {
  readonly watcher: ModelAlertWatcher | null;
  readonly webhookUrl: string;
  readonly here: EnvironmentId;
  readonly lineage: Pick<
    OrchestrationV2ThreadProjection["thread"]["lineage"],
    "parentThreadId" | "relationshipToParent"
  >;
}): ReadonlyArray<Destination> {
  const { watcher, lineage } = input;
  const watcherIsParent =
    watcher?.environmentId === input.here &&
    lineage.relationshipToParent === "subagent" &&
    watcher.threadId === lineage.parentThreadId;
  return [
    ...(watcher === null || watcherIsParent ? [] : (["watcher"] as const)),
    ...(input.webhookUrl.trim() === "" ? [] : (["webhook"] as const)),
  ];
}

export const threadEventDestinations = (
  recipient: ModelAlertWatcher | null,
  webhookUrl: string,
): ReadonlyArray<Destination> => [
  ...(recipient === null ? [] : (["watcher"] as const)),
  ...(webhookUrl.trim() === "" ? [] : (["webhook"] as const)),
];

const signature = (alert: ModelAlert) =>
  `${alert.reasons.join(",")}|${alert.executedModel ?? ""}|${alert.fallbackModels.join(",")}`;

/**
 * Records a run's outcome. A thread alerts once per signature: later runs with the same problem
 * stay quiet until a healthy run or a different problem.
 */
export function recordModelAlert(
  state: ModelAlertState,
  outcome: ReturnType<typeof modelAlertFor> & { readonly threadId: string },
  destinations: ReadonlyArray<Destination>,
  nowMs: number,
): { readonly state: ModelAlertState; readonly enqueued: boolean } {
  const { alert } = outcome;
  if (alert === undefined) {
    if (
      !outcome.healthy ||
      (state.degraded[outcome.threadId] === undefined &&
        state.resuming[outcome.threadId] === undefined)
    ) {
      return { state, enqueued: false };
    }
    const { [outcome.threadId]: _cleared, ...degraded } = state.degraded;
    const { [outcome.threadId]: _resumed, ...resuming } = state.resuming;
    return { state: { ...state, degraded, resuming }, enqueued: false };
  }
  const next = signature(alert);
  if (state.degraded[alert.threadId] === next) return { state, enqueued: false };
  const { [alert.threadId]: _previous, ...rest } = state.degraded;
  const kept = Object.entries(rest).slice(-(MAX_DEGRADED_THREADS - 1));
  const queued = enqueueAlert(state.outbox, alert, destinations, nowMs);
  return {
    state: {
      ...state,
      degraded: { ...Object.fromEntries(kept), [alert.threadId]: next },
      outbox: queued.outbox,
    },
    enqueued: queued.enqueued,
  };
}

/** The outbox with the alert queued once per destination; an alert already queued is not repeated. */
function enqueueAlert(
  outbox: ModelAlertState["outbox"],
  alert: WatcherAlert,
  destinations: ReadonlyArray<Destination>,
  nowMs: number,
): { readonly outbox: ModelAlertState["outbox"]; readonly enqueued: boolean } {
  const added = destinations
    .filter(
      (destination) =>
        !outbox.some((entry) => entry.alert.id === alert.id && entry.destination === destination),
    )
    .map((destination): Delivery => ({
      destination,
      alert,
      attempts: 0,
      nextAttemptAt: nowMs,
      createdAt: nowMs,
      digestExpiresAt: nowMs + ALERT_DIGEST_TTL_MS,
    }));
  return {
    outbox: [...pruneOutbox(outbox, nowMs), ...added].slice(-MAX_OUTBOX),
    enqueued: added.length > 0,
  };
}

const reportedKey = (threadId: string, kind: ThreadEventKind) => `${threadId}\n${kind}`;
const deliveredQueuePrefix = "delivered:";
const queueReportSignature = (signature: string) =>
  signature.startsWith(deliveredQueuePrefix)
    ? signature.slice(deliveredQueuePrefix.length)
    : signature;

function strandedAlertSignature(alert: WatcherAlert): string | undefined {
  if (alert.type !== "thread-event" || alert.kind !== "stuck") return undefined;
  const prefix = `${alert.environmentId}:${alert.threadId}:${alert.kind}:`;
  const suffix = `:${alert.occurredAt}`;
  if (!alert.id.startsWith(prefix) || !alert.id.endsWith(suffix)) return undefined;
  const signature = alert.id.slice(prefix.length, -suffix.length);
  return isStrandedQueueSignature(signature) ? signature : undefined;
}

function setReported(
  reported: ModelAlertState["reported"],
  key: string,
  signatures: ReadonlyArray<string>,
): ModelAlertState["reported"] {
  const { [key]: _previous, ...rest } = reported;
  return signatures.length === 0
    ? rest
    : {
        ...Object.fromEntries(Object.entries(rest).slice(-(MAX_REPORTED - 1))),
        [key]: signatures.join("\n"),
      };
}

function recordStrandedDelivery(
  reported: ModelAlertState["reported"],
  entry: Delivery,
  delivered: boolean,
) {
  if (entry.alert.type !== "thread-event") return reported;
  const signature = strandedAlertSignature(entry.alert);
  if (signature === undefined) return reported;
  const key = reportedKey(entry.alert.threadId, "stuck");
  const known = (reported[key] ?? "").split("\n").filter(Boolean);
  if (!delivered && !known.includes(signature)) return reported;
  const next = known.filter((candidate) => candidate !== signature);
  const sent = `${deliveredQueuePrefix}${signature}`;
  if (delivered && !next.includes(sent)) next.push(sent);
  return setReported(reported, key, next);
}

/**
 * Records what a trigger found true of a thread. A kind reports once per signature: it stays quiet
 * until the thread stops matching it or matches it with a different signature, such as a new run.
 */
export function recordThreadEvents(
  state: ModelAlertState,
  judged: {
    readonly threadId: string;
    readonly evaluated: ReadonlyArray<ThreadEventKind>;
    readonly findings: ReadonlyArray<ThreadFinding>;
    readonly strandedQueue?: StrandedQueue | null;
  },
  toAlert: (finding: ThreadFinding) => ThreadEventAlert,
  destinations: ReadonlyArray<Destination>,
  nowMs: number,
): { readonly state: ModelAlertState; readonly enqueued: boolean } {
  let reported = state.reported;
  let outbox = state.outbox;
  let enqueued = false;
  for (const kind of judged.evaluated) {
    const key = reportedKey(judged.threadId, kind);
    const kindFindings = judged.findings.filter((finding) => finding.kind === kind);
    // A kind can hold several findings at once (a question and an inbox flip), so it remembers
    // each signature it reported. One that stops being true is forgotten and can report again.
    const known = (reported[key] ?? "").split("\n").filter((signature) => signature !== "");
    const delivered = known.filter(
      (signature) =>
        kind === "stuck" &&
        keepStrandedQueueReport(queueReportSignature(signature), judged.strandedQueue),
    );
    for (const finding of kindFindings) {
      if (kind === "stuck" && isStrandedQueueSignature(finding.signature)) {
        if (
          delivered.some((signature) => queueReportSignature(signature) === finding.signature) ||
          outbox.some(
            (entry) =>
              entry.alert.type === "thread-event" &&
              entry.alert.threadId === judged.threadId &&
              nowMs - entry.createdAt < OUTBOX_TTL_MS &&
              strandedAlertSignature(entry.alert) === finding.signature,
          )
        )
          continue;
        const queued = enqueueAlert(outbox, toAlert(finding), destinations, nowMs);
        outbox = queued.outbox;
        enqueued ||= queued.enqueued;
        continue;
      }
      if (known.includes(finding.signature)) {
        if (!delivered.includes(finding.signature)) delivered.push(finding.signature);
        continue;
      }
      const queued = enqueueAlert(outbox, toAlert(finding), destinations, nowMs);
      outbox = queued.outbox;
      if (queued.enqueued) delivered.push(finding.signature);
      enqueued ||= queued.enqueued;
    }
    // A finding with nowhere to go stays unreported, so a later launcher or webhook still hears it.
    const stored = delivered.join("\n");
    if ((reported[key] ?? "") !== stored) {
      reported = setReported(reported, key, delivered);
    }
  }
  if (reported === state.reported && outbox === state.outbox) return { state, enqueued };
  return { state: { ...state, reported, outbox }, enqueued };
}

const linkReportedPrefix = (linkedEnvironmentId: string) => `peer-link\n${linkedEnvironmentId}\n`;
const linkReportedKey = (alert: PeerLinkRenewalAlert) =>
  `${linkReportedPrefix(alert.linkedEnvironmentId)}${alert.linkSession}`;
/** A link alert's `reported` entry once some destination received it. */
const linkDelivered = (id: string) => `delivered:${id}`;

/**
 * Records a link's renewal outcome. A failing link alerts once and stays quiet through every
 * later failure while that alert is queued or once it was delivered. A renewal, or linking
 * again, lets the next failure alert again, and so does an alert that expired from the outbox
 * undelivered. Nothing counts as reported until something was queued.
 */
export function recordLinkRenewal(
  state: ModelAlertState,
  outcome:
    | { readonly _tag: "renewed"; readonly linkedEnvironmentId: string }
    | { readonly _tag: "failed"; readonly alert: PeerLinkRenewalAlert },
  destinations: ReadonlyArray<Destination>,
  nowMs: number,
): { readonly state: ModelAlertState; readonly enqueued: boolean } {
  if (outcome._tag === "renewed") {
    const prefix = linkReportedPrefix(outcome.linkedEnvironmentId);
    const reported = Object.fromEntries(
      Object.entries(state.reported).filter(([key]) => !key.startsWith(prefix)),
    );
    if (Object.keys(reported).length === Object.keys(state.reported).length) {
      return { state, enqueued: false };
    }
    return { state: { ...state, reported }, enqueued: false };
  }
  const { alert } = outcome;
  const key = linkReportedKey(alert);
  const previous = state.reported[key];
  if (previous !== undefined) {
    const delivered = previous.startsWith(linkDelivered(""));
    const queued = pruneOutbox(state.outbox, nowMs).some((entry) => entry.alert.id === previous);
    if (delivered || queued) return { state, enqueued: false };
  }
  const queued = enqueueAlert(state.outbox, alert, destinations, nowMs);
  if (!queued.enqueued) return { state, enqueued: false };
  return {
    state: {
      ...state,
      reported: {
        ...Object.fromEntries(
          Object.entries(state.reported)
            .filter(([existing]) => existing !== key)
            .slice(-(MAX_REPORTED - 1)),
        ),
        [key]: alert.id,
      },
      outbox: queued.outbox,
    },
    enqueued: true,
  };
}

/** Marks a delivered link alert, so its link stays quiet until it renews or is linked again. */
const markLinkDelivered = (
  reported: ModelAlertState["reported"],
  entry: Delivery,
): ModelAlertState["reported"] => {
  if (entry.alert.type !== "peer-link-renewal") return reported;
  const key = linkReportedKey(entry.alert);
  return reported[key] === entry.alert.id
    ? { ...reported, [key]: linkDelivered(entry.alert.id) }
    : reported;
};

const pruneOutbox = (outbox: ReadonlyArray<Delivery>, nowMs: number) =>
  outbox.filter((entry) => nowMs - entry.createdAt < OUTBOX_TTL_MS);

const sameDelivery = (left: Delivery, right: Delivery) =>
  left.alert.id === right.alert.id && left.destination === right.destination;

/** The members of a stored incident that a delivered snapshot did not carry. */
const lateMembers = (stored: UsageLimitIncident, sent: UsageLimitIncident) =>
  stored.members.filter(
    (member) =>
      !sent.members.some(
        (known) => known.threadId === member.threadId && known.runId === member.runId,
      ),
  );

export function failureWakeHold(sentAt: number | undefined, nowMs: number) {
  if (sentAt === undefined) return null;
  const until = sentAt + FAILURE_WAKE_INTERVAL_MS;
  return until > nowMs ? until : null;
}

/**
 * The state after one delivery attempt: a delivered entry leaves, a failed one waits longer. An
 * incident that gained members while it was being sent keeps those for a later digest.
 */
export function afterDeliveryAttempt(
  state: ModelAlertState,
  entry: Delivery,
  delivered: boolean,
  nowMs: number,
): ModelAlertState {
  const sentIncident = delivered && entry.alert.type === "usage-limit-incident";
  const incidentSentAt =
    sentIncident && entry.destination === "watcher"
      ? Object.fromEntries(
          Object.entries({
            ...state.incidentSentAt,
            [entry.alert.groupKey]: nowMs,
          }).slice(-MAX_INCIDENT_GROUPS),
        )
      : state.incidentSentAt;
  return {
    ...state,
    incidentSentAt,
    failureWakeSentAt:
      delivered && entry.destination === "watcher" && isFailureWake(entry.alert)
        ? {
            ...Object.fromEntries(
              Object.entries(state.failureWakeSentAt).filter(
                ([, sentAt]) => sentAt + FAILURE_WAKE_INTERVAL_MS > nowMs,
              ),
            ),
            [entry.alert.threadId]: nowMs,
          }
        : state.failureWakeSentAt,
    reported: delivered
      ? recordStrandedDelivery(markLinkDelivered(state.reported, entry), entry, true)
      : state.reported,
    outbox: pruneOutbox(state.outbox, nowMs).flatMap((candidate) => {
      if (!sameDelivery(candidate, entry)) return [candidate];
      if (delivered) {
        if (
          candidate.alert.type === "usage-limit-incident" &&
          entry.alert.type === "usage-limit-incident"
        ) {
          const late = lateMembers(candidate.alert, entry.alert);
          if (late.length > 0) {
            return [
              {
                ...candidate,
                // A new id: the delivery key hashes it, and a second digest must not replay the first.
                alert: {
                  ...candidate.alert,
                  id: `${candidate.alert.groupKey}:${nowMs}`,
                  members: late,
                },
                attempts: 0,
                nextAttemptAt: nowMs + INCIDENT_GROUP_INTERVAL_MS,
              },
            ];
          }
        }
        return [];
      }
      const attempts = candidate.attempts + 1;
      return [
        {
          ...candidate,
          attempts,
          nextAttemptAt: nowMs + Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS),
        },
      ];
    }),
  };
}

/**
 * An entry nobody needs any more leaves without counting as sent. An incident keeps the members
 * that joined after the snapshot was judged, under a new id.
 */
export const afterDrop = (
  state: ModelAlertState,
  entry: Delivery,
  nowMs: number,
): ModelAlertState => ({
  ...state,
  reported: state.outbox.some(
    (candidate) => candidate.alert.id === entry.alert.id && !sameDelivery(candidate, entry),
  )
    ? state.reported
    : recordStrandedDelivery(state.reported, entry, false),
  outbox: state.outbox.flatMap((candidate) => {
    if (!sameDelivery(candidate, entry)) return [candidate];
    if (
      candidate.alert.type !== "usage-limit-incident" ||
      entry.alert.type !== "usage-limit-incident"
    ) {
      return [];
    }
    const late = lateMembers(candidate.alert, entry.alert);
    return late.length === 0
      ? []
      : [
          {
            ...candidate,
            alert: {
              ...candidate.alert,
              id: `${candidate.alert.groupKey}:${nowMs}`,
              members: late,
            },
          },
        ];
  }),
});

/** An entry held back, not failed: it waits for `untilMs` without counting an attempt. */
export function afterHold(
  state: ModelAlertState,
  entry: Delivery,
  untilMs: number,
): ModelAlertState {
  return {
    ...state,
    outbox: state.outbox.map((candidate) =>
      sameDelivery(candidate, entry) ? { ...candidate, nextAttemptAt: untilMs } : candidate,
    ),
  };
}

const BUSY_WATCHER_STATUSES = new Set<string>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
/** Matches the flush interval, so a held alert is looked at again on the next flush. */
export const BUSY_WATCHER_RECHECK_MS = 30_000;
export const BUSY_WATCHER_MAX_HOLD_MS = 10 * 60 * 1000;
/** How long an undelivered alert stays in the watcher's digest before it is dropped. */
const ALERT_DIGEST_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * While the watcher is mid-turn, a sent alert only queues behind that turn and is judged stale or
 * not when it was sent. Holding it until the turn ends lets the delivery check drop what went stale
 * meanwhile. Bounded, so a watcher that never goes idle still hears everything.
 */
export function busyWatcherHold(
  watcherStatus: string | null,
  createdAt: number,
  nowMs: number,
): number | null {
  if (watcherStatus === null || !BUSY_WATCHER_STATUSES.has(watcherStatus)) return null;
  const deadline = createdAt + BUSY_WATCHER_MAX_HOLD_MS;
  if (nowMs >= deadline) return null;
  return Math.min(nowMs + BUSY_WATCHER_RECHECK_MS, deadline);
}

/**
 * Records a thread that stopped at a usage limit. The server resumes it at the reset, so Lead
 * hears nothing unless it does not come back; otherwise every thread of one provider account
 * joins one queued incident, which waits briefly for the rest of the storm.
 */
export function recordUsageLimit(
  state: ModelAlertState,
  input: {
    readonly member: IncidentMember;
    readonly environmentId: string;
    readonly environmentLabel: string;
    readonly providerInstanceId: string;
    readonly resetAt: string | null;
    readonly resumeFailed: boolean;
    readonly willResume: boolean;
    /** Repeats of the same problem on the same run stay quiet. */
    readonly signature: string;
    readonly occurredAt: string;
  },
  destinations: ReadonlyArray<Destination>,
  nowMs: number,
): { readonly state: ModelAlertState; readonly enqueued: boolean } {
  const { member } = input;
  if (state.degraded[member.threadId] === input.signature) return { state, enqueued: false };
  const { [member.threadId]: _previous, ...restDegraded } = state.degraded;
  const { [member.threadId]: _resumed, ...restResuming } = state.resuming;
  const degraded = {
    ...Object.fromEntries(Object.entries(restDegraded).slice(-(MAX_DEGRADED_THREADS - 1))),
    [member.threadId]: input.signature,
  };
  if (input.willResume && input.resetAt !== null) {
    return {
      state: {
        ...state,
        degraded,
        resuming: {
          ...Object.fromEntries(Object.entries(restResuming).slice(-(MAX_RESUMING - 1))),
          [member.threadId]: { runId: member.runId, resetAt: input.resetAt, since: nowMs },
        },
      },
      enqueued: false,
    };
  }
  const groupKey = incidentGroupKey(input);
  let outbox = pruneOutbox(state.outbox, nowMs);
  let created = false;
  for (const destination of destinations) {
    const index = outbox.findIndex(
      (entry) =>
        entry.destination === destination &&
        entry.alert.type === "usage-limit-incident" &&
        entry.alert.groupKey === groupKey,
    );
    const queued = index === -1 ? undefined : outbox[index];
    const queuedAlert = queued?.alert;
    if (queued !== undefined && queuedAlert?.type === "usage-limit-incident") {
      outbox = outbox.map((entry, at) =>
        at === index
          ? { ...queued, alert: withIncidentMember(queuedAlert, member, input.resetAt) }
          : entry,
      );
      continue;
    }
    created = true;
    const sentAt = state.incidentSentAt[groupKey];
    const notBefore = Math.max(
      nowMs + INCIDENT_GROUP_WAIT_MS,
      sentAt === undefined ? 0 : sentAt + INCIDENT_GROUP_INTERVAL_MS,
    );
    outbox = [
      ...outbox,
      {
        destination,
        alert: {
          type: "usage-limit-incident" as const,
          id: `${groupKey}:${nowMs}`,
          groupKey,
          environmentId: input.environmentId,
          environmentLabel: input.environmentLabel,
          providerInstanceId: input.providerInstanceId,
          resumeFailed: input.resumeFailed,
          resetAt: input.resetAt,
          members: [member],
          occurredAt: input.occurredAt,
        },
        attempts: 0,
        nextAttemptAt: notBefore,
        createdAt: nowMs,
        digestExpiresAt: nowMs + ALERT_DIGEST_TTL_MS,
      },
    ].slice(-MAX_OUTBOX);
  }
  return {
    state: { ...state, degraded, resuming: restResuming, outbox },
    enqueued: created,
  };
}

/** Threads whose usage limit reset long enough ago that they should have been resumed. */
export const overdueResumes = (state: ModelAlertState, nowMs: number) =>
  Object.entries(state.resuming).filter(
    ([, entry]) => Date.parse(entry.resetAt) + RESUME_GRACE_MS < nowMs,
  );

const REASON_TEXT: Record<ModelAlert["reasons"][number], (alert: ModelAlert) => string> = {
  model_substituted: (alert) =>
    `it ran ${alert.executedModel ?? "another model"} instead of ${alert.selectedModel}`,
  provider_fallback: (alert) =>
    `a provider safeguard switched it to ${alert.fallbackModels.join(", ")}`,
  usage_limit: () => "it hit a provider usage limit",
  withheld_task: () => "its final message withholds the task",
};

function modelAlertMessage(alert: ModelAlert): string {
  const why = alert.reasons.map((reason) => REASON_TEXT[reason](alert)).join("; ");
  return [
    `Model alert from ${alert.environmentLabel} (environment ${alert.environmentId}): ${alert.threadLink} ${why}.`,
    `Selected model: ${alert.selectedModel}. Executed model: ${alert.executedModel ?? "not reported"}. Provider: ${alert.providerInstanceId}. Run ${alert.runId} ended ${alert.runStatus}. Reasons: ${alert.reasons.join(", ")}.`,
    "Fix it: switch the thread's model or provider, or replace it. That thread sends no further alert until the problem changes.",
  ].join("\n\n");
}

function linkRenewalMessage(alert: PeerLinkRenewalAlert): string {
  return [
    `Link alert from ${alert.environmentLabel} (environment ${alert.environmentId}): its link to ${alert.linkedLabel} (environment ${alert.linkedEnvironmentId}) could not renew its credential. It stops working at ${alert.expiresAt}, and then delegation and the shared inbox between the two machines stop.`,
    `Last failure: ${alert.detail}`,
    `Fix it: make sure ${alert.linkedLabel} is on, reachable and on a T3 Code build that renews links; ${alert.environmentLabel} retries every hour by itself. If its session there was revoked, link again. This link sends no further alert until it renews.`,
  ].join("\n\n");
}

export const watcherAlertMessage = (alert: WatcherAlert) => {
  switch (alert.type) {
    case "peer-link-renewal":
      return linkRenewalMessage(alert);
    case "thread-event":
      return threadEventMessage(alert);
    case "usage-limit-incident":
      return incidentMessage(alert);
    case "model-degraded":
      return modelAlertMessage(alert);
  }
};

const isFailureWake = (
  alert: WatcherAlert,
): alert is ThreadEventAlert & { kind: "thread-failed" } =>
  alert.type === "thread-event" && alert.kind === "thread-failed";

/** Alerts ride in the watcher's next digest; a newer alert on the same subject replaces an older one. */
function alertDelivery(alert: WatcherAlert): {
  readonly coalesceKey: string;
  readonly category: OrchestrationV2DigestCategory;
} {
  switch (alert.type) {
    case "peer-link-renewal":
      return { coalesceKey: `${alert.type}:${alert.linkedEnvironmentId}`, category: "alert" };
    case "usage-limit-incident":
      return { coalesceKey: `${alert.type}:${alert.groupKey}`, category: "alert" };
    case "model-degraded":
      return { coalesceKey: `${alert.type}:${alert.threadId}`, category: "alert" };
    case "thread-event":
      return {
        coalesceKey: `${alert.type}:${alert.kind}:${alert.threadId}`,
        category:
          alert.kind === "lane-ended"
            ? "lane_result"
            : alert.kind === "needs-person"
              ? "decision_needed"
              : "alert",
      };
  }
}

/**
 * Puts an alert in the watcher thread, here or on the linked machine that owns it. The retry key is
 * one per alert and watcher, so a retry after a lost answer sends once.
 */
export const deliverAlertToWatcher = Effect.fnUntraced(function* (
  deps: {
    readonly dispatch: Orchestrator.OrchestratorV2["Service"]["dispatch"];
    readonly call: PeerMcpClient.PeerMcpClient["Service"]["call"];
    readonly sha256Hex: (identity: string) => Effect.Effect<string>;
    /** Reads a thread's redirect tombstone; an alert for a retired watcher goes to its replacement. */
    readonly getThreadShell?: Orchestrator.OrchestratorV2["Service"]["getThreadShell"];
  },
  alert: WatcherAlert,
  watcher: ModelAlertWatcher,
  here: EnvironmentId,
  expiresAtMs?: number,
) {
  const message = watcherAlertMessage(alert);
  // Run ids can be long; a retry key must stay under the 256 characters the peer accepts.
  const identity = `${alert.id}\n${watcher.environmentId}\n${watcher.threadId}`;
  const key = `${alert.type === "model-degraded" ? "model-alert" : alert.type}:${yield* deps.sha256Hex(identity)}`;
  const { coalesceKey, category } = alertDelivery(alert);
  const expiresAt = DateTime.makeUnsafe(
    expiresAtMs ?? DateTime.toEpochMillis(yield* DateTime.now) + ALERT_DIGEST_TTL_MS,
  );
  const deliveryClass = isFailureWake(alert) ? "next_turn" : "digest";
  if (watcher.environmentId === here) {
    // A retired watcher never takes a turn: the alert follows its redirect, or is dropped with a
    // warning when the chain cannot be resolved.
    const target =
      deps.getThreadShell === undefined
        ? watcher.threadId
        : yield* resolveWakeTarget(deps.getThreadShell, watcher.threadId, {
            sourceKind: "event",
          }).pipe(
            Effect.map((wake) => wake.threadId),
            Effect.catchCause((cause) =>
              Effect.logWarning("alert for retired watcher dropped", { cause }).pipe(
                Effect.as(null),
              ),
            ),
          );
    if (target === null) return;
    yield* deps.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:${key}`),
      threadId: target,
      messageId: MessageId.make(`message:${key}`),
      text: message,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      delivery: { class: deliveryClass, coalesceKey, expiresAt, category },
      createdBy: "agent",
      creationSource: "server",
    });
    return;
  }
  yield* deps.call({
    environmentId: watcher.environmentId,
    tool: "t3_thread_send",
    arguments: {
      threadId: watcher.threadId,
      message,
      mode: "queue",
      clientRequestId: key,
      deliveryClass,
      coalesceKey,
      expiresAt: DateTime.formatIso(expiresAt),
      digestCategory: category,
    },
    limits: { runtimeMode: "full-access", interactionMode: "default" },
    success: OrchestratorMcpThreadSendResult,
  });
});

const ModelAlertStateJson = Schema.fromJsonString(ModelAlertState);
const decodeState = Schema.decodeUnknownOption(ModelAlertStateJson);
const encodeState = Schema.encodeEffect(ModelAlertStateJson);

export class ModelAlertReactor extends Context.Service<
  ModelAlertReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Judges a domain event; a finished run may queue an alert. */
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /** Attempts every queued delivery that is due. */
    readonly flush: Effect.Effect<void>;
    /** Judges every live lane for the time-based events: stuck. */
    readonly sweep: Effect.Effect<void>;
    /** A link here renewed, or could not: a failing link tells the watcher once until it renews. */
    readonly linkRenewal: (
      outcome:
        | { readonly _tag: "renewed"; readonly linkedEnvironmentId: string }
        | { readonly _tag: "failed"; readonly alert: PeerLinkRenewalAlert },
    ) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ModelAlertReactor") {}

const TERMINAL_RUN_STATUSES: ReadonlyArray<OrchestrationV2Run["status"]> = [
  "completed",
  "failed",
  "interrupted",
];

export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const subscriptionStore = yield* Effect.serviceOption(
    EventSubscriptionStore.EventSubscriptionStore,
  );
  let eventWakeSeq = 0;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const crypto = yield* Digest.Digest;
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.stateDir, "model-alerts.json");

  const loaded = yield* fs.readFileString(filePath).pipe(
    Effect.map((text) => decodeState(text)),
    Effect.map((state) => (state._tag === "Some" ? state.value : EMPTY_MODEL_ALERT_STATE)),
    Effect.orElseSucceed(() => EMPTY_MODEL_ALERT_STATE),
  );
  const state = yield* Ref.make(loaded);
  const lock = yield* Semaphore.make(1);
  const wake = yield* Queue.dropping<void>(1);

  const update = <A>(change: (current: ModelAlertState) => readonly [A, ModelAlertState]) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const [result, next] = change(current);
        if (next === current) return result;
        yield* Ref.set(state, next);
        yield* encodeState(next).pipe(
          Effect.flatMap((contents) => writeFileStringAtomically({ filePath, contents })),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.catchCause((cause) =>
            Effect.logWarning("saving model alerts failed", { filePath, cause }),
          ),
        );
        return result;
      }),
    );

  const sha256Hex = (identity: string) =>
    crypto
      .digest(Digest.sha256, new TextEncoder().encode(identity))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
  const deliverToWatcher = (
    alert: WatcherAlert,
    watcher: ModelAlertWatcher,
    here: EnvironmentId,
    expiresAtMs: number,
  ) =>
    deliverAlertToWatcher(
      {
        dispatch: engine.dispatch,
        call: peers.call,
        sha256Hex,
        getThreadShell: (threadId) => engine.getThreadShell(threadId),
      },
      alert,
      watcher,
      here,
      expiresAtMs,
    );

  type WatcherView = {
    readonly status: string;
    readonly providerInstanceId: string | null;
    /** Null when unknown, as for a remote watcher. */
    readonly usageLimited: boolean | null;
    readonly resetAt: string | null;
  };
  const WatcherThreadStatus = Schema.Struct({
    thread: Schema.Struct({ status: Schema.String, providerInstanceId: Schema.String }),
  });

  /**
   * Whether the parent already started a replacement for this delegated child: a later child of
   * the same parent with the same task title.
   */
  const replacedByParent = Effect.fnUntraced(function* (shell: OrchestrationV2ThreadShell) {
    const parentId = shell.lineage.parentThreadId;
    if (parentId === null || shell.lineage.relationshipToParent !== "subagent") return false;
    const children = yield* projections.listAppOwnedChildThreadIds(parentId);
    const at = children.indexOf(shell.id);
    if (at === -1) return false;
    const later = yield* Effect.forEach(children.slice(at + 1, at + 21), (id) =>
      projections.getThreadShell(id),
    );
    return replacedBySibling(
      shell,
      later.flatMap((sibling) => (sibling === null ? [] : [sibling])),
    );
  });

  /**
   * The alert as it stands now: threads that moved on leave it, and null means nothing is left to
   * say. A thread moved on when it has a newer run that runs or finished, is settled, archived or
   * on another provider, or its parent replaced it.
   */
  const currentAlert = Effect.fnUntraced(function* (alert: WatcherAlert) {
    // A link that renewed while its alert waited has nothing left to say.
    if (alert.type === "peer-link-renewal") {
      const reported = (yield* Ref.get(state)).reported[linkReportedKey(alert)];
      return reported === alert.id || reported === linkDelivered(alert.id) ? alert : null;
    }
    const stillCurrent = Effect.fnUntraced(function* (
      threadId: string,
      runId: string | null,
      about:
        | { readonly providerInstanceId: string; readonly newerRunSupersedes?: boolean }
        | undefined,
    ) {
      const shell = yield* projections.getThreadShell(ThreadId.make(threadId));
      if (alertIsStale(shell, runId, about)) return false;
      return about === undefined || shell === null || !(yield* replacedByParent(shell));
    });
    if (alert.type === "usage-limit-incident") {
      const fresh = yield* Effect.filter(alert.members, (member) =>
        stillCurrent(member.threadId, member.runId, {
          providerInstanceId: alert.providerInstanceId,
        }),
      );
      if (fresh.length === 0) return null;
      return fresh.length === alert.members.length ? alert : { ...alert, members: fresh };
    }
    // A healthy run clears the thread's degraded mark; until then a newer run is no fix.
    if (
      alert.type === "model-degraded" &&
      (yield* Ref.get(state)).degraded[alert.threadId] === undefined
    ) {
      return null;
    }
    const about =
      alert.type === "model-degraded"
        ? { providerInstanceId: alert.providerInstanceId, newerRunSupersedes: false }
        : undefined;
    if (!(yield* stillCurrent(alert.threadId, alert.runId, about))) return null;
    if (alert.type === "thread-event") {
      const shell = yield* projections.getThreadShell(ThreadId.make(alert.threadId));
      if (shell === null) return null;
      const holds = threadEventStillHolds({
        hasStalenessWait: yield* hasActiveStalenessWait(shell, REJUDGE_TRIGGER[alert.kind]),
        alert,
        shell,
        stuckMinutes: (yield* settings.getSettings).watcherStuckMinutes,
        ...(yield* judgeContext(shell, REJUDGE_TRIGGER[alert.kind])),
      });
      if (!holds) return null;
    }
    return alert;
  });

  /** What the shell does not carry: open delegated tasks elsewhere, and children's last activity. */
  const hasActiveStalenessWait = Effect.fnUntraced(function* (
    shell: OrchestrationV2ThreadShell,
    trigger: ThreadEventTrigger,
  ) {
    return (
      trigger === "sweep" &&
      shell.activeRunId !== null &&
      ((yield* projections.getThread(shell.id)).stalenessWaits ?? []).some(
        (wait) =>
          wait.kind === "delegate" ||
          shell.pendingBackgroundTasks?.some(
            (task) => task.taskId === wait.taskId && task.awaited === true,
          ),
      )
    );
  });

  const judgeContext = Effect.fnUntraced(function* (
    shell: OrchestrationV2ThreadShell,
    trigger: ThreadEventTrigger,
    remoteTasks?: ReadonlyMap<string, number>,
    queuedThreads?: ReadonlySet<ThreadId>,
  ) {
    const remoteTaskCount =
      trigger === "request" || trigger === "inbox"
        ? 0
        : remoteTasks !== undefined
          ? (remoteTasks.get(shell.id) ?? 0)
          : (yield* projections.getOpenRemoteDelegatedTasks).filter(
              (task) => task.parentThreadId === shell.id,
            ).length;
    // A parent that waits on children is not stuck while they work.
    const childActivityMs =
      trigger === "sweep"
        ? Math.max(
            0,
            ...(yield* Effect.forEach(
              (shell.pendingBackgroundTasks ?? []).flatMap((task) =>
                task.kind === "subagent" && task.childThreadId !== undefined
                  ? [task.childThreadId]
                  : [],
              ),
              (childId) =>
                projections
                  .getThreadShell(childId)
                  .pipe(
                    Effect.map((child) =>
                      child === null ? 0 : DateTime.toEpochMillis(child.updatedAt),
                    ),
                  ),
            )),
          )
        : null;
    if (trigger !== "sweep" || shell.activeRunId !== null || shell.activityRunStatus != null) {
      return { remoteTaskCount, childActivityMs };
    }
    if (queuedThreads !== undefined && !queuedThreads.has(shell.id)) {
      return { remoteTaskCount, childActivityMs, strandedQueue: null };
    }
    const now = yield* DateTime.now;
    const { runs } = yield* projections.getThreadRecords(shell.id, ["runs"]);
    const queued = runs
      .filter(
        (run) =>
          run.status === "queued" &&
          run.delivery?.class !== "digest" &&
          (run.delivery?.expiresAt === undefined ||
            DateTime.isGreaterThan(run.delivery.expiresAt, now)),
      )
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(left.requestedAt) - DateTime.toEpochMillis(right.requestedAt),
      );
    const latestRun = latestExecutedRun(runs);
    const oldest = queued.find((run) => run.queueHeld !== true) ?? queued[0];
    const strandedQueue =
      oldest === undefined
        ? null
        : {
            runId: oldest.id,
            requestedAt: oldest.requestedAt,
            lastCompletedAt: latestRun?.completedAt ?? null,
            queueHeld:
              oldest.queueHeld === true ||
              (shell.lastErrorClass === "usage_limit" &&
                latestRun?.providerInstanceId === oldest.providerInstanceId),
          };
    return { remoteTaskCount, childActivityMs, strandedQueue };
  });

  /** The watcher thread as one delivery needs it, or null when it cannot be read. */
  const readWatcher = Effect.fnUntraced(function* (
    watcher: ModelAlertWatcher,
    here: EnvironmentId,
  ) {
    if (watcher.environmentId === here) {
      const shell = yield* projections.getThreadShell(watcher.threadId);
      if (shell === null) return null;
      // A queued digest never starts a turn, so the shell hides it and reads idle. It is still a
      // turn waiting to be judged, and another alert queueing behind it would be judged stale.
      const digestWaiting =
        shell.status === "idle" &&
        (yield* projections.getThreadRecords(watcher.threadId, ["runs"])).runs.some(
          (run) => run.status === "queued" && run.delivery?.class === "digest",
        );
      return {
        status: (digestWaiting ? "queued" : shell.status) as string,
        providerInstanceId: shell.providerInstanceId as string | null,
        usageLimited: shell.lastErrorClass === "usage_limit",
        resetAt: shell.usageLimitResetAt ?? null,
      } satisfies WatcherView;
    }
    return yield* peers
      .call({
        environmentId: watcher.environmentId,
        tool: "t3_thread_read",
        arguments: { threadId: watcher.threadId, limit: 1, runLimit: 1 },
        limits: { runtimeMode: "full-access", interactionMode: "default" },
        success: WatcherThreadStatus,
      })
      .pipe(
        // The read result carries no error class or reset time.
        Effect.map(({ thread }): WatcherView => ({
          status: thread.status,
          providerInstanceId: thread.providerInstanceId,
          usageLimited: null,
          resetAt: null,
        })),
        // A read that fails or dies must never block the alert; deliver as if idle.
        Effect.catchCause(() => Effect.succeed(null)),
      );
  });

  /**
   * When the watcher's own thread is stopped at the same account limit, the time to look again.
   * Anything sent now would only queue a turn that fails the same way.
   */
  const holdUntil = (view: WatcherView | null, alert: WatcherAlert, nowMs: number) => {
    const providerInstanceId =
      alert.type === "usage-limit-incident" ||
      (alert.type === "model-degraded" && alert.reasons.includes("usage_limit"))
        ? alert.providerInstanceId
        : null;
    if (providerInstanceId === null || view === null) return null;
    // A remote watcher counts as down only while the reset this alert reports is still ahead.
    const down =
      view.status === "failed" &&
      view.providerInstanceId === providerInstanceId &&
      view.usageLimited !== false;
    const resetAt = view.resetAt ?? (alert.type === "usage-limit-incident" ? alert.resetAt : null);
    if (!down) return null;
    // Past the reset the limit is over: whatever keeps the watcher down, a message may restart it.
    const resetMs = resetAt === null ? Number.NaN : Date.parse(resetAt);
    if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;
    return Math.min(resetMs, nowMs + HOLD_RECHECK_MS);
  };

  type DeliveryResult =
    | { readonly _tag: "sent" }
    | { readonly _tag: "dropped" }
    | { readonly _tag: "held"; readonly until: number };

  const deliver = Effect.fnUntraced(function* (
    entry: Delivery,
    watcherView: Effect.Effect<WatcherView | null>,
  ) {
    const current = yield* settings.getSettings;
    const alert = yield* currentAlert(entry.alert);
    if (alert === null) {
      yield* Effect.logInfo("watcher alert no longer true; dropped without waking anyone", {
        alertId: entry.alert.id,
        type: entry.alert.type,
        kind: entry.alert.type === "thread-event" ? entry.alert.kind : null,
        destination: entry.destination,
      });
      return { _tag: "dropped" } satisfies DeliveryResult;
    }
    if (entry.destination === "webhook") {
      const url = current.modelAlertWebhookUrl.trim();
      if (url === "") {
        return {
          _tag: strandedAlertSignature(alert) === undefined ? "sent" : "dropped",
        } satisfies DeliveryResult;
      }
      // A webhook URL can embed a credential, so its failure names only the host.
      const host = URL.canParse(url) ? new URL(url).host : "an unparsable URL";
      yield* http
        .execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(alert)))
        .pipe(Effect.catchCause(() => Effect.fail(`model alert webhook POST to ${host} failed`)));
      return { _tag: "sent" } satisfies DeliveryResult;
    }
    const watcher = current.modelAlertWatcher;
    const target =
      alert.type === "thread-event" && !isFailureWake(alert) ? (alert.recipient ?? null) : watcher;
    if (
      isFailureWake(alert) &&
      (target === null ||
        (target.environmentId === alert.environmentId && target.threadId === alert.threadId))
    ) {
      return { _tag: "dropped" } satisfies DeliveryResult;
    }
    if (target === null) return { _tag: "sent" } satisfies DeliveryResult;
    const here = yield* environment.getEnvironmentId;
    const nowMs = yield* Clock.currentTimeMillis;
    if (isFailureWake(alert)) {
      const sentAt = (yield* Ref.get(state)).failureWakeSentAt[alert.threadId];
      const until = failureWakeHold(sentAt, nowMs);
      if (until !== null) return { _tag: "held", until } satisfies DeliveryResult;
    }
    const view =
      target.environmentId === watcher?.environmentId && target.threadId === watcher.threadId
        ? yield* watcherView
        : yield* readWatcher(target, here).pipe(Effect.catchCause(() => Effect.succeed(null)));
    const until =
      holdUntil(view, alert, nowMs) ??
      busyWatcherHold(view?.status ?? null, entry.createdAt, nowMs);
    if (until !== null) return { _tag: "held", until } satisfies DeliveryResult;
    yield* deliverToWatcher(
      alert,
      target,
      here,
      entry.digestExpiresAt ?? nowMs + ALERT_DIGEST_TTL_MS,
    );
    return { _tag: "sent" } satisfies DeliveryResult;
  });

  const cursorUnchanged = (current: EventSubscription, next: EventSubscription) =>
    current.coalesceUntilMs === next.coalesceUntilMs &&
    current.pendingSummaries.join("\0") === next.pendingSummaries.join("\0") &&
    current.wakeTimesMs.join(",") === next.wakeTimesMs.join(",") &&
    JSON.stringify(current.deliveredSignatures) === JSON.stringify(next.deliveredSignatures);

  const subscriberIsIdle = Effect.fnUntraced(function* (subscription: EventSubscription) {
    if (!subscription.delivery.onlyWhenIdle) return true;
    const shell = yield* projections
      .getThreadShell(subscription.subscriberThreadId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    return (
      shell !== null &&
      shell.deletedAt === null &&
      shell.activeRunId === null &&
      (shell.activityRunStatus ?? null) === null
    );
  });

  const applyThreadPlan = Effect.fnUntraced(function* (
    subscription: EventSubscription,
    watchedThreadId: ThreadId,
    title: string,
    findings: ReadonlyArray<{
      readonly kind: string;
      readonly detail: string;
      readonly signature: string;
    }>,
    settled: boolean,
  ) {
    if (Option.isNone(subscriptionStore)) return;
    const store = subscriptionStore.value;
    const decision = planThreadSubscription({
      findings,
      events: subscription.events ?? [],
      delivery: subscription.delivery,
      idle: yield* subscriberIsIdle(subscription),
      nowMs: yield* Clock.currentTimeMillis,
      state: cursorOf(subscription),
      settled,
    });
    if (decision.action === "wake") {
      eventWakeSeq += 1;
      const seq = eventWakeSeq;
      const wakeTarget = yield* resolveWakeTarget(
        (threadId) => engine.getThreadShell(threadId),
        subscription.subscriberThreadId,
        { sourceKind: "event", subscriptionId: subscription.id },
      ).pipe(
        Effect.map((wake) => wake.threadId),
        Effect.catchCause((cause) =>
          Effect.logWarning("event subscription wake dropped", {
            id: subscription.id,
            threadId: subscription.subscriberThreadId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      if (wakeTarget !== null)
        yield* engine
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`server:event-sub:${subscription.id}:${seq}`),
            threadId: wakeTarget,
            messageId: MessageId.make(`message:event-sub:${subscription.id}:${seq}`),
            text: [
              `Update on thread ${title} (${watchedThreadId}), which you subscribed to:`,
              ...decision.summaries,
            ].join("\n"),
            notification: {
              source: { kind: "monitor" },
              outcome: "updated",
              summary: decision.summaries[0] ?? "thread event",
            },
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("event subscription wake failed", {
                id: subscription.id,
                threadId: subscription.subscriberThreadId,
                cause,
              }),
            ),
          );
    }
    if (decision.expire) {
      yield* store.remove(subscription.subscriberThreadId, subscription.id).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("event subscription removal failed", {
            id: subscription.id,
            cause,
          }),
        ),
        Effect.asVoid,
      );
      return;
    }
    const next = withCursor(subscription, decision.state);
    if (cursorUnchanged(subscription, next)) return;
    yield* store
      .put(next)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("event subscription update failed", { id: subscription.id, cause }),
        ),
      );
  });

  const subscriptionsForThread = (threadId: ThreadId) =>
    Option.isNone(subscriptionStore)
      ? Effect.succeed<ReadonlyArray<EventSubscription>>([])
      : subscriptionStore.value
          .listForSelector(threadSelectorKey(threadId))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("event subscription read failed", { threadId, cause }).pipe(
                Effect.as<ReadonlyArray<EventSubscription>>([]),
              ),
            ),
          );

  const flushPendingThreadSubscriptions = Effect.gen(function* () {
    if (Option.isNone(subscriptionStore)) return;
    const rows = yield* subscriptionStore.value
      .listAll()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("event subscription flush failed", { cause }).pipe(
            Effect.as<ReadonlyArray<EventSubscription>>([]),
          ),
        ),
      );
    yield* Effect.forEach(
      rows.filter((row) => row.selector.entity === "thread" && row.pendingSummaries.length > 0),
      (subscription) =>
        Effect.gen(function* () {
          if (
            subscription.selector.entity !== "thread" ||
            subscription.selector.by !== "thread_id"
          ) {
            return;
          }
          const shell = yield* projections
            .getThreadShell(subscription.selector.threadId)
            .pipe(Effect.catchCause(() => Effect.succeed(null)));
          yield* applyThreadPlan(
            subscription,
            subscription.selector.threadId,
            shell?.title ?? subscription.selector.threadId,
            [],
            false,
          );
        }),
      { discard: true },
    );
  });

  const flush: ModelAlertReactor["Service"]["flush"] = Effect.gen(function* () {
    yield* flushPendingThreadSubscriptions.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("flushing thread event subscriptions failed", { cause }),
      ),
    );
    const nowMs = yield* Clock.currentTimeMillis;
    const due = (yield* Ref.get(state)).outbox.filter((entry) => entry.nextAttemptAt <= nowMs);
    if (due.length === 0) return;
    // One read of the watcher per flush, shared by every alert due in it.
    const watcherView = yield* Effect.cached(
      Effect.gen(function* () {
        const watcher = (yield* settings.getSettings).modelAlertWatcher;
        if (watcher === null) return null;
        return yield* readWatcher(watcher, yield* environment.getEnvironmentId);
      }).pipe(Effect.catchCause(() => Effect.succeed(null))),
    );
    // One at a time: a delivery queues a turn on the watcher, and the next alert in this
    // flush has to see that turn to hold instead of queueing behind it.
    yield* Effect.forEach(
      due,
      (entry) =>
        Effect.gen(function* () {
          const result = yield* deliver(entry, watcherView).pipe(
            Effect.timeout("30 seconds"),
            Effect.catchCause((cause) =>
              Effect.logWarning("delivering a model alert failed; it will be retried", {
                alertId: entry.alert.id,
                destination: entry.destination,
                attempts: entry.attempts + 1,
                cause,
              }).pipe(Effect.as(undefined)),
            ),
          );
          const attemptedAt = yield* Clock.currentTimeMillis;
          yield* update((current) => [
            undefined,
            result === undefined
              ? afterDeliveryAttempt(current, entry, false, attemptedAt)
              : result._tag === "held"
                ? afterHold(current, entry, result.until)
                : result._tag === "dropped"
                  ? afterDrop(current, entry, attemptedAt)
                  : afterDeliveryAttempt(current, entry, true, attemptedAt),
          ]);
        }),
      { concurrency: 1, discard: true },
    );
  });

  /** Folds a thread that stopped at a usage limit into its provider account's one incident. */
  const handleUsageLimit = Effect.fnUntraced(function* (
    event: Extract<OrchestrationV2DomainEvent, { readonly type: "run.updated" }>,
    alert: ModelAlert,
  ) {
    const current = yield* settings.getSettings;
    const shell = yield* projections.getThreadShell(event.threadId);
    const nowMs = yield* Clock.currentTimeMillis;
    const resumeFailed = event.payload.usageLimitContinuationOfRunId !== undefined;
    const resetMs =
      shell?.usageLimitResetAt == null ? Number.NaN : Date.parse(shell.usageLimitResetAt);
    // New launches on this provider are refused until the reset, so they alert nobody.
    if (Number.isFinite(resetMs) && resetMs > nowMs) {
      ProviderExhaustion.mark(alert.providerInstanceId, resetMs);
    }
    const parentId = shell?.lineage.parentThreadId ?? null;
    const parent =
      parentId !== null && shell?.lineage.relationshipToParent === "subagent"
        ? yield* projections.getThreadShell(parentId)
        : undefined;
    const willResume = expectsAutoResume({
      autoResumeEnabled: current.autoResumeLimitedThreads,
      runWasResume: resumeFailed,
      shell,
      parentClosed:
        parent !== undefined &&
        (parent === null || parent.archivedAt !== null || parent.settledOverride === "settled"),
      nowMs,
      graceMs: RESUME_GRACE_MS,
    });
    const here = yield* environment.getEnvironmentId;
    const destinations = modelAlertDestinations({
      watcher: current.modelAlertWatcher,
      webhookUrl: current.modelAlertWebhookUrl,
      here,
      lineage: shell?.lineage ?? { parentThreadId: null, relationshipToParent: null },
    });
    const label = (yield* environment.getDescriptor).label;
    const enqueued = yield* update((state) => {
      const result = recordUsageLimit(
        state,
        {
          member: {
            threadId: alert.threadId,
            threadTitle: alert.threadTitle,
            threadLink: alert.threadLink,
            runId: alert.runId,
          },
          environmentId: here,
          environmentLabel: label,
          providerInstanceId: alert.providerInstanceId,
          resetAt: shell?.usageLimitResetAt ?? null,
          resumeFailed,
          willResume,
          signature: `usage_limit:${resumeFailed ? "resume-failed" : "limit"}:${alert.runId}`,
          occurredAt: alert.occurredAt,
        },
        destinations,
        nowMs,
      );
      return [result.enqueued, result.state];
    });
    if (willResume) {
      yield* Effect.logInfo("a usage limit stopped a thread; it resumes by itself at the reset", {
        threadId: alert.threadId,
        resetAt: shell?.usageLimitResetAt,
      });
    }
    if (enqueued) yield* Queue.offer(wake, undefined);
  });

  /** Queues a run's model alert, and says whether it reported a usage limit. */
  const handleModelAlert = Effect.fnUntraced(function* (
    event: Extract<OrchestrationV2DomainEvent, { readonly type: "run.updated" }>,
  ) {
    const run = event.payload;
    const records = yield* projections.getThreadRecords(
      event.threadId,
      ["providerTurns", "turnItems"],
      {
        providerTurnAttemptIds: run.activeAttemptId === null ? [] : [run.activeAttemptId],
        turnItemRunIds: [run.id],
        turnItemTypes: ["system_notice", "error"],
      },
    );
    const here = yield* environment.getEnvironmentId;
    const judged = modelAlertFor({
      environmentId: here,
      environmentLabel: "",
      thread: records.thread,
      run,
      projection: records,
      occurredAt: DateTime.formatIso(yield* DateTime.now),
    });
    if (judged.alert === undefined && judged.healthy) {
      ProviderExhaustion.clear(run.providerInstanceId);
    }
    if (judged.alert === undefined && !judged.healthy) return { usageLimited: false };
    if (judged.alert?.reasons.every((reason) => reason === "usage_limit") === true) {
      yield* handleUsageLimit(event, judged.alert);
      return { usageLimited: true };
    }
    const outcome =
      judged.alert === undefined
        ? judged
        : {
            ...judged,
            alert: {
              ...judged.alert,
              environmentLabel: (yield* environment.getDescriptor).label,
            },
          };
    const current = yield* settings.getSettings;
    const destinations = modelAlertDestinations({
      watcher: current.modelAlertWatcher,
      webhookUrl: current.modelAlertWebhookUrl,
      here,
      lineage: records.thread.lineage,
    });
    const nowMs = yield* Clock.currentTimeMillis;
    const enqueued = yield* update((current) => {
      const result = recordModelAlert(
        current,
        { ...outcome, threadId: event.threadId },
        destinations,
        nowMs,
      );
      return [result.enqueued, result.state];
    });
    if (enqueued) yield* Queue.offer(wake, undefined);
    return { usageLimited: judged.alert?.reasons.includes("usage_limit") === true };
  });

  const launchingThread = Effect.fnUntraced(function* (
    shell: OrchestrationV2ThreadShell,
    here: EnvironmentId,
  ) {
    const threadId = launchingThreadId(shell.inbox);
    if (threadId === null || threadId === shell.id) return null;
    const launcher = yield* projections.getThreadShell(ThreadId.make(threadId));
    if (launcher === null || launcher.deletedAt !== null || launcher.archivedAt !== null) {
      return null;
    }
    return { environmentId: here, threadId: launcher.id } satisfies ModelAlertWatcher;
  });

  /** Judges one thread for the kinds a trigger can change, and queues what is newly true. */
  const handleThreadEvents = Effect.fnUntraced(function* (
    threadId: ThreadId,
    trigger: ThreadEventTrigger,
    usageLimitReported: boolean,
    /** Open delegated tasks by parent thread, when the caller read them once for many threads. */
    remoteTasks?: ReadonlyMap<string, number>,
    queuedThreads?: ReadonlySet<ThreadId>,
  ) {
    const current = yield* settings.getSettings;
    const here = yield* environment.getEnvironmentId;
    const watcher = current.modelAlertWatcher;
    // The watcher's own turns would report to itself forever. A subscription on that
    // thread still delivers to its subscriber.
    const selfWatch = watcher?.environmentId === here && watcher.threadId === threadId;
    const noGlobalDestination = watcher === null && current.modelAlertWebhookUrl.trim() === "";
    const subscribed = yield* subscriptionsForThread(threadId);
    if ((selfWatch || noGlobalDestination) && subscribed.length === 0) return;
    const shell = yield* projections.getThreadShell(threadId);
    if (shell === null || shell.deletedAt !== null) return;
    const nowMs = yield* Clock.currentTimeMillis;
    const context = yield* judgeContext(shell, trigger, remoteTasks, queuedThreads);
    const judged = judgeThread({
      hasStalenessWait: yield* hasActiveStalenessWait(shell, trigger),
      shell,
      trigger,
      nowMs,
      stuckMinutes: current.watcherStuckMinutes,
      ...context,
      usageLimitReported,
    });
    const label = (yield* environment.getDescriptor).label;
    const occurredAt = DateTime.formatIso(yield* DateTime.now);
    const launcher = yield* launchingThread(shell, here);
    const hasFailure = judged.findings.some((finding) => finding.kind === "thread-failed");
    const launcherIsWatcher =
      launcher !== null &&
      launcher.environmentId === watcher?.environmentId &&
      launcher.threadId === watcher.threadId;
    if (
      !selfWatch &&
      !noGlobalDestination &&
      launcher === null &&
      current.modelAlertWebhookUrl.trim() === "" &&
      judged.findings.some((finding) => finding.kind !== "thread-failed")
    ) {
      yield* Effect.logWarning("a thread event has no launching thread and no webhook", {
        threadId,
        kinds: judged.findings.map((finding) => finding.kind),
      });
    }
    const enqueued =
      selfWatch || noGlobalDestination
        ? false
        : yield* update((initial) => {
            let state = initial;
            let queued = false;
            for (const kind of judged.evaluated) {
              const overlapping = kind === "lane-ended" && hasFailure;
              const recipient =
                kind === "thread-failed"
                  ? watcher
                  : overlapping && launcherIsWatcher
                    ? null
                    : launcher;
              const destinations = threadEventDestinations(
                recipient,
                kind === "thread-failed" ? "" : current.modelAlertWebhookUrl,
              );
              const result = recordThreadEvents(
                state,
                { threadId, evaluated: [kind], findings: judged.findings, ...context },
                (finding) =>
                  threadEventAlert({
                    environmentId: here,
                    environmentLabel: label,
                    shell,
                    finding,
                    occurredAt,
                    recipient,
                  }),
                destinations,
                nowMs,
              );
              state = result.state;
              queued ||= result.enqueued;
            }
            return [queued, state];
          });
    if (enqueued) yield* Queue.offer(wake, undefined);
    yield* Effect.forEach(
      subscribed,
      (subscription) =>
        applyThreadPlan(
          subscription,
          threadId,
          shell.title,
          judged.findings,
          trigger === "settled",
        ),
      { discard: true },
    );
  });

  const threadTrigger = (event: OrchestrationV2DomainEvent): ThreadEventTrigger | undefined => {
    switch (event.type) {
      case "run.updated":
        return TERMINAL_RUN_STATUSES.includes(event.payload.status) ? "run-ended" : undefined;
      case "thread.settled":
        return "settled";
      case "thread.metadata-updated":
        return "inbox";
      case "runtime-request.updated":
        return "request";
      default:
        return undefined;
    }
  };

  const handle: ModelAlertReactor["Service"]["handle"] = Effect.fnUntraced(function* (event) {
    const trigger = threadTrigger(event);
    if (trigger === undefined) return;
    const modelAlert =
      event.type === "run.updated"
        ? yield* handleModelAlert(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("judging a run for a model alert failed", {
                threadId: event.threadId,
                cause,
              }).pipe(Effect.as({ usageLimited: false })),
            ),
          )
        : { usageLimited: false };
    yield* handleThreadEvents(event.threadId, trigger, modelAlert.usageLimited).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("judging a thread for a watcher event failed", {
          threadId: event.threadId,
          trigger,
          cause,
        }),
      ),
    );
  });

  /** Looks at every thread that may be live for the time-based kinds no event announces. */
  /**
   * A thread the server was to resume is still stopped long after its reset: that is the one
   * usage limit outcome Lead hears about.
   */
  const sweepResumes = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const overdue = overdueResumes(yield* Ref.get(state), nowMs);
    if (overdue.length === 0) return;
    const current = yield* settings.getSettings;
    const here = yield* environment.getEnvironmentId;
    const label = (yield* environment.getDescriptor).label;
    const occurredAt = DateTime.formatIso(yield* DateTime.now);
    yield* Effect.forEach(
      overdue,
      ([threadId, entry]) =>
        Effect.gen(function* () {
          const shell = yield* projections.getThreadShell(ThreadId.make(threadId));
          const notResumed =
            shell !== null &&
            shell.latestRunId === entry.runId &&
            shell.status === "failed" &&
            shell.archivedAt === null &&
            shell.settledOverride !== "settled";
          const destinations = modelAlertDestinations({
            watcher: current.modelAlertWatcher,
            webhookUrl: current.modelAlertWebhookUrl,
            here,
            lineage: shell?.lineage ?? { parentThreadId: null, relationshipToParent: null },
          });
          const enqueued = yield* update((state) => {
            const { [threadId]: _done, ...resuming } = state.resuming;
            const cleared = { ...state, resuming };
            if (!notResumed) return [false, cleared];
            const result = recordUsageLimit(
              cleared,
              {
                member: {
                  threadId,
                  threadTitle: shell.title,
                  threadLink: formatThreadLink(
                    { environmentId: here, threadId: shell.id },
                    shell.title,
                  ),
                  runId: entry.runId,
                },
                environmentId: here,
                environmentLabel: label,
                providerInstanceId: shell.providerInstanceId,
                resetAt: entry.resetAt,
                resumeFailed: true,
                willResume: false,
                signature: `usage_limit:resume-missed:${entry.runId}`,
                occurredAt,
              },
              destinations,
              nowMs,
            );
            return [result.enqueued, result.state];
          });
          if (enqueued) yield* Queue.offer(wake, undefined);
        }),
      { discard: true },
    );
  });

  const sweep: ModelAlertReactor["Service"]["sweep"] = Effect.gen(function* () {
    yield* sweepResumes.pipe(
      Effect.catchCause((cause) => Effect.logWarning("resume sweep failed", { cause })),
    );
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(
      yield* projections.listStalenessWaitThreads,
      (threadId) =>
        engine
          .dispatch({
            type: "thread.wait-staleness.update",
            commandId: CommandId.make(`server:wait-staleness:${threadId}:${now}`),
            threadId,
            operation: { type: "sweep" },
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("wait staleness sweep failed", { threadId, cause }),
            ),
          ),
      { discard: true },
    );
    const index = yield* projections.listActiveShellIndex();
    const queuedThreads = new Set(yield* projections.getRecoveryThreadIds("queued-runs"));
    // One scan of the delegated tasks for the whole sweep, not one per thread.
    const remoteTasks = new Map<string, number>();
    for (const task of yield* projections.getOpenRemoteDelegatedTasks) {
      remoteTasks.set(task.parentThreadId, (remoteTasks.get(task.parentThreadId) ?? 0) + 1);
    }
    yield* Effect.forEach(
      index.filter((entry) => entry.mayBeLive && isListedThreadLineage(entry.lineage)),
      (entry) =>
        handleThreadEvents(entry.id, "sweep", false, remoteTasks, queuedThreads).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("sweeping a thread for a watcher event failed", {
              threadId: entry.id,
              cause,
            }),
          ),
        ),
      { discard: true },
    );
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("watcher sweep failed", { cause })));

  const linkRenewal: ModelAlertReactor["Service"]["linkRenewal"] = Effect.fn(
    "ModelAlertReactor.linkRenewal",
  )(
    function* (outcome) {
      const current = yield* settings.getSettings;
      const destinations = modelAlertDestinations({
        watcher: current.modelAlertWatcher,
        webhookUrl: current.modelAlertWebhookUrl,
        here: yield* environment.getEnvironmentId,
        lineage: { parentThreadId: null, relationshipToParent: null },
      });
      const nowMs = yield* Clock.currentTimeMillis;
      const enqueued = yield* update((state) => {
        const result = recordLinkRenewal(state, outcome, destinations, nowMs);
        return [result.enqueued, result.state];
      });
      if (enqueued) yield* Queue.offer(wake, undefined);
    },
    Effect.catchCause((cause) => Effect.logWarning("recording a link renewal failed", { cause })),
  );

  const start: ModelAlertReactor["Service"]["start"] = Effect.fn("ModelAlertReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, handle).pipe(
          Effect.tapCause((cause) =>
            Effect.logWarning("model alert event stream failed; resubscribing", { cause }),
          ),
          Effect.retry(Schedule.spaced("5 seconds")),
        ),
      );
      // Retries wait out a sleeping or restarting watcher machine; a new alert goes at once.
      yield* forkParked(
        Effect.forever(
          Queue.take(wake).pipe(
            Effect.timeoutOption("30 seconds"),
            Effect.andThen(flush),
            Effect.catchCause((cause) => Effect.logWarning("model alert flush failed", { cause })),
          ),
        ),
      );
      // Stuck lanes emit no event, so the sweep is the one timer here.
      yield* forkParked(sweep.pipe(Effect.repeat(Schedule.spaced("60 seconds"))));
    },
  );

  return ModelAlertReactor.of({ start, handle, flush, sweep, linkRenewal });
});

export const layer = Layer.effect(ModelAlertReactor, make).pipe(
  Layer.provide(EventSubscriptionStore.layer),
);
