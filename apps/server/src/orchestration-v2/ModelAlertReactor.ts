import {
  CommandId,
  type EnvironmentId,
  isListedThreadLineage,
  MessageId,
  type ModelAlertWatcher,
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
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
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

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ProviderExhaustion } from "./ProviderExhaustion.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  judgeThread,
  threadEventAlert,
  ThreadEventAlert,
  type ThreadEventKind,
  threadEventMessage,
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

/** Everything the watcher thread hears: model alerts, thread events and usage limit incidents. */
export const WatcherAlert = Schema.Union([ModelAlert, ThreadEventAlert, UsageLimitIncident]);
export type WatcherAlert = typeof WatcherAlert.Type;

const Destination = Schema.Literals(["watcher", "webhook"]);
type Destination = typeof Destination.Type;

const Delivery = Schema.Struct({
  destination: Destination,
  alert: WatcherAlert,
  attempts: Schema.Int,
  nextAttemptAt: Schema.Number,
  createdAt: Schema.Number,
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
  outbox: Schema.Array(Delivery),
});
export type ModelAlertState = typeof ModelAlertState.Type;

export const EMPTY_MODEL_ALERT_STATE: ModelAlertState = {
  version: 1,
  degraded: {},
  reported: {},
  resuming: {},
  incidentSentAt: {},
  outbox: [],
};

const MAX_DEGRADED_THREADS = 1_000;
const MAX_REPORTED = 2_000;
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
    }));
  return {
    outbox: [...pruneOutbox(outbox, nowMs), ...added].slice(-MAX_OUTBOX),
    enqueued: added.length > 0,
  };
}

const reportedKey = (threadId: string, kind: ThreadEventKind) => `${threadId}\n${kind}`;

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
    if (kindFindings.length === 0) {
      if (reported[key] !== undefined) {
        const { [key]: _cleared, ...rest } = reported;
        reported = rest;
      }
      continue;
    }
    // A kind can hold several findings at once (a question and an inbox flip), so it remembers
    // each signature it reported. One that stops being true is forgotten and can report again.
    const known = (reported[key] ?? "").split("\n").filter((signature) => signature !== "");
    const current = kindFindings.map((finding) => finding.signature);
    const stored = current.join("\n");
    if (reported[key] !== stored) {
      const { [key]: _previous, ...rest } = reported;
      reported = {
        ...Object.fromEntries(Object.entries(rest).slice(-(MAX_REPORTED - 1))),
        [key]: stored,
      };
    }
    for (const finding of kindFindings) {
      if (known.includes(finding.signature)) continue;
      const queued = enqueueAlert(outbox, toAlert(finding), destinations, nowMs);
      outbox = queued.outbox;
      enqueued ||= queued.enqueued;
    }
  }
  if (reported === state.reported && outbox === state.outbox) return { state, enqueued };
  return { state: { ...state, reported, outbox }, enqueued };
}

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

const BUSY_WATCHER_STATUSES = new Set<string>(["preparing", "queued", "starting", "running"]);
/** Matches the flush interval, so a held alert is looked at again on the next flush. */
export const BUSY_WATCHER_RECHECK_MS = 30_000;
export const BUSY_WATCHER_MAX_HOLD_MS = 10 * 60 * 1000;

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

export const watcherAlertMessage = (alert: WatcherAlert) => {
  switch (alert.type) {
    case "thread-event":
      return threadEventMessage(alert);
    case "usage-limit-incident":
      return incidentMessage(alert);
    case "model-degraded":
      return modelAlertMessage(alert);
  }
};

/**
 * Puts an alert in the watcher thread, here or on the linked machine that owns it. The retry key is
 * one per alert and watcher, so a retry after a lost answer sends once.
 */
export const deliverAlertToWatcher = Effect.fnUntraced(function* (
  deps: {
    readonly dispatch: Orchestrator.OrchestratorV2["Service"]["dispatch"];
    readonly call: PeerMcpClient.PeerMcpClient["Service"]["call"];
    readonly sha256Hex: (identity: string) => Effect.Effect<string>;
  },
  alert: WatcherAlert,
  watcher: ModelAlertWatcher,
  here: EnvironmentId,
) {
  const message = watcherAlertMessage(alert);
  // Run ids can be long; a retry key must stay under the 256 characters the peer accepts.
  const identity = `${alert.id}\n${watcher.environmentId}\n${watcher.threadId}`;
  const key = `${alert.type === "model-degraded" ? "model-alert" : alert.type}:${yield* deps.sha256Hex(identity)}`;
  if (watcher.environmentId === here) {
    yield* deps.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:${key}`),
      threadId: watcher.threadId,
      messageId: MessageId.make(`message:${key}`),
      text: message,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
    return;
  }
  yield* deps.call({
    environmentId: watcher.environmentId,
    tool: "t3_thread_send",
    arguments: { threadId: watcher.threadId, message, mode: "queue", clientRequestId: key },
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
  }
>()("t3/orchestration-v2/ModelAlertReactor") {}

const TERMINAL_RUN_STATUSES: ReadonlyArray<OrchestrationV2Run["status"]> = [
  "completed",
  "failed",
  "interrupted",
];

export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
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
  const deliverToWatcher = (alert: WatcherAlert, watcher: ModelAlertWatcher, here: EnvironmentId) =>
    deliverAlertToWatcher(
      { dispatch: engine.dispatch, call: peers.call, sha256Hex },
      alert,
      watcher,
      here,
    );

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
        alert,
        shell,
        stuckMinutes: (yield* settings.getSettings).watcherStuckMinutes,
        ...(yield* judgeContext(shell, alert.kind === "stuck" ? "sweep" : "run-ended")),
      });
      if (!holds) return null;
    }
    return alert;
  });

  /** What the shell does not carry: open delegated tasks elsewhere, and children's last activity. */
  const judgeContext = Effect.fnUntraced(function* (
    shell: OrchestrationV2ThreadShell,
    trigger: ThreadEventTrigger,
    remoteTasks?: ReadonlyMap<string, number>,
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
    return { remoteTaskCount, childActivityMs };
  });

  /** The watcher thread's run status, or null when it cannot be read. */
  const watcherStatus = Effect.fnUntraced(function* (
    watcher: ModelAlertWatcher,
    here: EnvironmentId,
  ) {
    if (watcher.environmentId === here) {
      return (yield* projections.getThreadShell(watcher.threadId))?.status ?? null;
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
        Effect.map(({ thread }) => thread.status),
        // A read that fails or dies must never block the alert; deliver as if idle.
        Effect.catchCause(() => Effect.succeed(null)),
      );
  });

  /**
   * When the watcher's own thread is stopped at the same account limit, the time to look again.
   * Anything sent now would only queue a turn that fails the same way.
   */
  const holdUntil = Effect.fnUntraced(function* (
    watcher: ModelAlertWatcher,
    here: EnvironmentId,
    alert: WatcherAlert,
    nowMs: number,
  ) {
    const providerInstanceId =
      alert.type === "usage-limit-incident" ||
      (alert.type === "model-degraded" && alert.reasons.includes("usage_limit"))
        ? alert.providerInstanceId
        : null;
    if (providerInstanceId === null) return null;
    let down = false;
    let resetAt: string | null = alert.type === "usage-limit-incident" ? alert.resetAt : null;
    if (watcher.environmentId === here) {
      const shell = yield* projections.getThreadShell(watcher.threadId);
      down =
        shell !== null &&
        shell.status === "failed" &&
        shell.providerInstanceId === providerInstanceId &&
        shell.lastErrorClass === "usage_limit";
      resetAt = shell?.usageLimitResetAt ?? resetAt;
    } else {
      // The read result carries no error class, so a remote watcher counts as down only while
      // the reset this alert reports is still ahead.
      down = yield* peers
        .call({
          environmentId: watcher.environmentId,
          tool: "t3_thread_read",
          arguments: { threadId: watcher.threadId, limit: 1, runLimit: 1 },
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          success: WatcherThreadStatus,
        })
        .pipe(
          Effect.map(
            ({ thread }) =>
              thread.status === "failed" && thread.providerInstanceId === providerInstanceId,
          ),
          // An unreadable watcher is the delivery's problem, not a reason to hold.
          Effect.orElseSucceed(() => false),
        );
    }
    if (!down) return null;
    // Past the reset the limit is over: whatever keeps the watcher down, a message may restart it.
    const resetMs = resetAt === null ? Number.NaN : Date.parse(resetAt);
    if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;
    return Math.min(resetMs, nowMs + HOLD_RECHECK_MS);
  });

  type DeliveryResult =
    | { readonly _tag: "sent" }
    | { readonly _tag: "dropped" }
    | { readonly _tag: "held"; readonly until: number };

  const deliver = Effect.fnUntraced(function* (entry: Delivery) {
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
      if (url === "") return { _tag: "sent" } satisfies DeliveryResult;
      // A webhook URL can embed a credential, so its failure names only the host.
      const host = URL.canParse(url) ? new URL(url).host : "an unparsable URL";
      yield* http
        .execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(alert)))
        .pipe(Effect.catchCause(() => Effect.fail(`model alert webhook POST to ${host} failed`)));
      return { _tag: "sent" } satisfies DeliveryResult;
    }
    const watcher = current.modelAlertWatcher;
    if (watcher === null) return { _tag: "sent" } satisfies DeliveryResult;
    const here = yield* environment.getEnvironmentId;
    const nowMs = yield* Clock.currentTimeMillis;
    const until =
      (yield* holdUntil(watcher, here, alert, nowMs)) ??
      busyWatcherHold(yield* watcherStatus(watcher, here), entry.createdAt, nowMs);
    if (until !== null) return { _tag: "held", until } satisfies DeliveryResult;
    yield* deliverToWatcher(alert, watcher, here);
    return { _tag: "sent" } satisfies DeliveryResult;
  });

  const flush: ModelAlertReactor["Service"]["flush"] = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const due = (yield* Ref.get(state)).outbox.filter((entry) => entry.nextAttemptAt <= nowMs);
    yield* Effect.forEach(
      due,
      (entry) =>
        Effect.gen(function* () {
          const result = yield* deliver(entry).pipe(
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
      { concurrency: 4, discard: true },
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

  /** Judges one thread for the kinds a trigger can change, and queues what is newly true. */
  const handleThreadEvents = Effect.fnUntraced(function* (
    threadId: ThreadId,
    trigger: ThreadEventTrigger,
    usageLimitReported: boolean,
    /** Open delegated tasks by parent thread, when the caller read them once for many threads. */
    remoteTasks?: ReadonlyMap<string, number>,
  ) {
    const current = yield* settings.getSettings;
    const here = yield* environment.getEnvironmentId;
    const watcher = current.modelAlertWatcher;
    // The watcher's own turns would report to itself forever.
    if (watcher?.environmentId === here && watcher.threadId === threadId) return;
    if (watcher === null && current.modelAlertWebhookUrl.trim() === "") return;
    const shell = yield* projections.getThreadShell(threadId);
    if (shell === null || shell.deletedAt !== null) return;
    const nowMs = yield* Clock.currentTimeMillis;
    const judged = judgeThread({
      shell,
      trigger,
      nowMs,
      stuckMinutes: current.watcherStuckMinutes,
      ...(yield* judgeContext(shell, trigger, remoteTasks)),
      usageLimitReported,
    });
    const label = (yield* environment.getDescriptor).label;
    const occurredAt = DateTime.formatIso(yield* DateTime.now);
    const destinations = modelAlertDestinations({
      watcher,
      webhookUrl: current.modelAlertWebhookUrl,
      here,
      lineage: shell.lineage,
    });
    const enqueued = yield* update((state) => {
      const result = recordThreadEvents(
        state,
        { threadId, evaluated: judged.evaluated, findings: judged.findings },
        (finding) =>
          threadEventAlert({
            environmentId: here,
            environmentLabel: label,
            shell,
            finding,
            occurredAt,
          }),
        destinations,
        nowMs,
      );
      return [result.enqueued, result.state];
    });
    if (enqueued) yield* Queue.offer(wake, undefined);
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
    const index = yield* projections.listActiveShellIndex();
    // One scan of the delegated tasks for the whole sweep, not one per thread.
    const remoteTasks = new Map<string, number>();
    for (const task of yield* projections.getOpenRemoteDelegatedTasks) {
      remoteTasks.set(task.parentThreadId, (remoteTasks.get(task.parentThreadId) ?? 0) + 1);
    }
    yield* Effect.forEach(
      index.filter((entry) => entry.mayBeLive && isListedThreadLineage(entry.lineage)),
      (entry) =>
        handleThreadEvents(entry.id, "sweep", false, remoteTasks).pipe(
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

  return ModelAlertReactor.of({ start, handle, flush, sweep });
});

export const layer = Layer.effect(ModelAlertReactor, make);
