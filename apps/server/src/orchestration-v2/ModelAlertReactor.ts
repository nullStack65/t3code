import {
  CommandId,
  type EnvironmentId,
  isListedThreadLineage,
  MessageId,
  type ModelAlertWatcher,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2WorkerAlertReason,
  OrchestratorMcpThreadSendResult,
  type ThreadId,
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
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  judgeThread,
  threadEventAlert,
  ThreadEventAlert,
  type ThreadEventKind,
  threadEventMessage,
  type ThreadEventTrigger,
  type ThreadFinding,
} from "./ThreadEventAlerts.ts";

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

/** Everything the watcher thread hears: model alerts and deterministic thread events. */
export const WatcherAlert = Schema.Union([ModelAlert, ThreadEventAlert]);
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
  outbox: Schema.Array(Delivery),
});
export type ModelAlertState = typeof ModelAlertState.Type;

export const EMPTY_MODEL_ALERT_STATE: ModelAlertState = {
  version: 1,
  degraded: {},
  reported: {},
  outbox: [],
};

const MAX_DEGRADED_THREADS = 1_000;
const MAX_REPORTED = 2_000;
const MAX_OUTBOX = 200;
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
    if (!outcome.healthy || state.degraded[outcome.threadId] === undefined) {
      return { state, enqueued: false };
    }
    const { [outcome.threadId]: _cleared, ...degraded } = state.degraded;
    return { state: { ...state, degraded }, enqueued: false };
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

/** The state after one delivery attempt: a delivered entry leaves, a failed one waits longer. */
export function afterDeliveryAttempt(
  state: ModelAlertState,
  entry: Delivery,
  delivered: boolean,
  nowMs: number,
): ModelAlertState {
  return {
    ...state,
    outbox: pruneOutbox(state.outbox, nowMs).flatMap((candidate) => {
      if (!sameDelivery(candidate, entry)) return [candidate];
      if (delivered) return [];
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

export const watcherAlertMessage = (alert: WatcherAlert) =>
  alert.type === "thread-event" ? threadEventMessage(alert) : modelAlertMessage(alert);

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
  const key = `${alert.type === "thread-event" ? "thread-event" : "model-alert"}:${yield* deps.sha256Hex(identity)}`;
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

  const deliver = Effect.fnUntraced(function* (entry: Delivery) {
    const current = yield* settings.getSettings;
    if (entry.destination === "webhook") {
      const url = current.modelAlertWebhookUrl.trim();
      if (url === "") return;
      // A webhook URL can embed a credential, so its failure names only the host.
      const host = URL.canParse(url) ? new URL(url).host : "an unparsable URL";
      yield* http
        .execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(entry.alert)))
        .pipe(Effect.catchCause(() => Effect.fail(`model alert webhook POST to ${host} failed`)));
      return;
    }
    const watcher = current.modelAlertWatcher;
    if (watcher === null) return;
    yield* deliverToWatcher(entry.alert, watcher, yield* environment.getEnvironmentId);
  });

  const flush: ModelAlertReactor["Service"]["flush"] = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const due = (yield* Ref.get(state)).outbox.filter((entry) => entry.nextAttemptAt <= nowMs);
    yield* Effect.forEach(
      due,
      (entry) =>
        Effect.gen(function* () {
          const delivered = yield* deliver(entry).pipe(
            Effect.timeout("30 seconds"),
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("delivering a model alert failed; it will be retried", {
                alertId: entry.alert.id,
                destination: entry.destination,
                attempts: entry.attempts + 1,
                cause,
              }).pipe(Effect.as(false)),
            ),
          );
          const attemptedAt = yield* Clock.currentTimeMillis;
          yield* update((current) => [
            undefined,
            afterDeliveryAttempt(current, entry, delivered, attemptedAt),
          ]);
        }),
      { concurrency: 4, discard: true },
    );
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
    if (judged.alert === undefined && !judged.healthy) return { usageLimited: false };
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
    const remoteTaskCount =
      trigger === "request" || trigger === "inbox"
        ? 0
        : remoteTasks !== undefined
          ? (remoteTasks.get(threadId) ?? 0)
          : (yield* projections.getOpenRemoteDelegatedTasks).filter(
              (task) => task.parentThreadId === threadId,
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
    const nowMs = yield* Clock.currentTimeMillis;
    const judged = judgeThread({
      shell,
      trigger,
      nowMs,
      stuckMinutes: current.watcherStuckMinutes,
      remoteTaskCount,
      childActivityMs,
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
  const sweep: ModelAlertReactor["Service"]["sweep"] = Effect.gen(function* () {
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
