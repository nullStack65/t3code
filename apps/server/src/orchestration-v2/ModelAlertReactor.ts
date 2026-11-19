import {
  CommandId,
  type EnvironmentId,
  MessageId,
  type ModelAlertWatcher,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2WorkerAlertReason,
  OrchestratorMcpThreadSendResult,
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

const Destination = Schema.Literals(["watcher", "webhook"]);
type Destination = typeof Destination.Type;

const Delivery = Schema.Struct({
  destination: Destination,
  alert: ModelAlert,
  attempts: Schema.Int,
  nextAttemptAt: Schema.Number,
  createdAt: Schema.Number,
});
type Delivery = typeof Delivery.Type;

export const ModelAlertState = Schema.Struct({
  version: Schema.Literal(1),
  /** The alert signature each thread last reported; a healthy run clears it. */
  degraded: Schema.Record(Schema.String, Schema.String),
  outbox: Schema.Array(Delivery),
});
export type ModelAlertState = typeof ModelAlertState.Type;

export const EMPTY_MODEL_ALERT_STATE: ModelAlertState = { version: 1, degraded: {}, outbox: [] };

const MAX_DEGRADED_THREADS = 1_000;
const MAX_OUTBOX = 200;
const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 15 * 60 * 1000;

/** A run's model alert, or whether it shows the thread healthy again. Runs with no signal are neither. */
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
    return {
      alert: undefined,
      healthy: run.status === "completed" && signals.executedModel !== undefined,
    };
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
  const added = destinations
    .filter(
      (destination) =>
        !state.outbox.some(
          (entry) => entry.alert.id === alert.id && entry.destination === destination,
        ),
    )
    .map((destination): Delivery => ({
      destination,
      alert,
      attempts: 0,
      nextAttemptAt: nowMs,
      createdAt: nowMs,
    }));
  return {
    state: {
      ...state,
      degraded: { ...Object.fromEntries(kept), [alert.threadId]: next },
      outbox: [...pruneOutbox(state.outbox, nowMs), ...added].slice(-MAX_OUTBOX),
    },
    enqueued: added.length > 0,
  };
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

  const deliverToWatcher = Effect.fnUntraced(function* (
    alert: ModelAlert,
    watcher: ModelAlertWatcher,
    here: EnvironmentId,
  ) {
    const message = modelAlertMessage(alert);
    // Run ids can be long; a retry key must stay under the 256 characters the peer accepts.
    const digest = yield* crypto
      .digest(Digest.sha256, new TextEncoder().encode(alert.id))
      .pipe(Effect.orDie);
    const key = `model-alert:${Hex.encode(digest)}`;
    if (watcher.environmentId === here) {
      yield* engine.dispatch({
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
    // The watcher's machine keeps one retry key per alert, so a retry after a lost answer sends once.
    yield* peers.call({
      environmentId: watcher.environmentId,
      tool: "t3_thread_send",
      arguments: { threadId: watcher.threadId, message, mode: "queue", clientRequestId: key },
      limits: { runtimeMode: "full-access", interactionMode: "default" },
      success: OrchestratorMcpThreadSendResult,
    });
  });

  const deliver = Effect.fnUntraced(function* (entry: Delivery) {
    const current = yield* settings.getSettings;
    if (entry.destination === "webhook") {
      const url = current.modelAlertWebhookUrl.trim();
      if (url === "") return;
      yield* http.execute(
        HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(entry.alert)),
      );
      return;
    }
    const watcher = current.modelAlertWatcher;
    if (watcher === null) return;
    yield* deliverToWatcher(entry.alert, watcher, yield* environment.getEnvironmentId);
  });

  const flush: ModelAlertReactor["Service"]["flush"] = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const due = (yield* Ref.get(state)).outbox.filter((entry) => entry.nextAttemptAt <= nowMs);
    for (const entry of due) {
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
    }
  });

  const handle: ModelAlertReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "run.updated" || !TERMINAL_RUN_STATUSES.includes(event.payload.status)) {
        return;
      }
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
      const descriptor = yield* environment.getDescriptor;
      const outcome = modelAlertFor({
        environmentId: descriptor.environmentId,
        environmentLabel: descriptor.label,
        thread: records.thread,
        run,
        projection: records,
        occurredAt: DateTime.formatIso(yield* DateTime.now),
      });
      if (outcome.alert === undefined && !outcome.healthy) return;
      const current = yield* settings.getSettings;
      const watcher = current.modelAlertWatcher;
      const destinations: Array<Destination> = [];
      // A delegated child's parent already hears this with its result; don't tell it twice.
      if (
        watcher !== null &&
        !(
          watcher.environmentId === descriptor.environmentId &&
          watcher.threadId === records.thread.lineage.parentThreadId
        )
      ) {
        destinations.push("watcher");
      }
      if (current.modelAlertWebhookUrl.trim() !== "") destinations.push("webhook");
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
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("judging a run for a model alert failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: ModelAlertReactor["Service"]["start"] = Effect.fn("ModelAlertReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, handle).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("model alert event stream failed", { cause }),
          ),
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
    },
  );

  return ModelAlertReactor.of({ start, handle, flush });
});

export const layer = Layer.effect(ModelAlertReactor, make);
