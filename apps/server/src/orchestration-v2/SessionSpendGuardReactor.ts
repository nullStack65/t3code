import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type SessionSpendGuardSettings,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  describeSpendStop,
  evaluateThreadSpend,
  SPEND_GUARD_FLAGGED_KIND,
  SPEND_GUARD_STOPPED_KIND,
  type SpendGuardEvaluation,
  type SpendGuardMarkerKind,
  type SpendGuardStopReason,
  spendGuardNoticeId,
} from "./SessionSpendGuard.ts";

export interface SpendGuardNotice {
  readonly kind: SpendGuardMarkerKind;
  readonly reason: SpendGuardStopReason;
  readonly title: string;
  readonly message: string;
}

export function spendGuardNotice(
  evaluation: SpendGuardEvaluation,
  settings: SessionSpendGuardSettings,
): SpendGuardNotice | null {
  if (evaluation.level === "stop" && evaluation.stopReason !== null) {
    const alreadyStopped =
      evaluation.stopReason === "ceiling"
        ? evaluation.stoppedForCeiling
        : evaluation.stoppedSinceIdle;
    if (alreadyStopped) return null;
    return {
      kind: SPEND_GUARD_STOPPED_KIND,
      reason: evaluation.stopReason,
      title:
        evaluation.stopReason === "ceiling"
          ? "Stopped: session spend ceiling reached"
          : "Stopped: spending with no pull request or file changes",
      message: describeSpendStop(evaluation, settings),
    };
  }
  if (evaluation.level === "flag" && evaluation.stopReason === "ceiling") {
    if (evaluation.flaggedForCeiling) return null;
    return {
      kind: SPEND_GUARD_FLAGGED_KIND,
      reason: "ceiling",
      title: "Session spend ceiling reached",
      message: describeSpendStop(evaluation, settings),
    };
  }
  if (evaluation.level === "flag" && !evaluation.flaggedSinceIdle) {
    return {
      kind: SPEND_GUARD_FLAGGED_KIND,
      reason: "idle",
      title: "Spending with no pull request or file changes",
      message: `This thread has spent about $${evaluation.idleUsd.toFixed(2)} since its last linked pull request or file-changing turn. It stops at $${settings.idleStopUsd.toFixed(2)}.`,
    };
  }
  return null;
}

export function wakeSettledThread(
  thread: OrchestrationV2AppThread,
  now: DateTime.Utc,
): OrchestrationV2AppThread | null {
  return thread.settledOverride === "settled"
    ? { ...thread, settledOverride: null, settledAt: null, unsettledAt: now, updatedAt: now }
    : null;
}

const isLive = (run: OrchestrationV2Run) => run.status === "starting" || run.status === "running";

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const pending = new Set<ThreadId>();

  const check = Effect.fn("SessionSpendGuardReactor.check")(function* (threadId: ThreadId) {
    pending.delete(threadId);
    const settings = yield* settingsService.getSettings;
    if (settings.sessionSpendGuard.mode === "off") return;
    const records = yield* projections.getThreadRecords(
      threadId,
      ["runs", "providerTurns", "checkpoints", "turnItems"],
      { turnItemTypes: ["system_notice"] },
    );
    const evaluation = evaluateThreadSpend(records, settings);
    const notice = spendGuardNotice(evaluation, settings.sessionSpendGuard);
    if (notice === null) return;
    const run = records.runs.reduce<OrchestrationV2Run | undefined>(
      (latest, candidate) =>
        latest === undefined || candidate.ordinal > latest.ordinal ? candidate : latest,
      undefined,
    );
    if (run === undefined) return;
    const now = yield* DateTime.now;
    const thread = wakeSettledThread(records.thread, now);
    const noticeEventId = yield* ids.allocate.event({ threadId });
    yield* eventSink.write({
      events: [
        ...(thread === null
          ? []
          : [
              {
                id: yield* ids.allocate.event({ threadId }),
                type: "thread.unsettled" as const,
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: now,
                payload: thread,
              },
            ]),
        {
          id: noticeEventId,
          type: "turn-item.updated",
          threadId,
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(
              spendGuardNoticeId(threadId, notice.kind, notice.reason, noticeEventId),
            ),
            threadId,
            runId: run.id,
            nodeId: run.rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed",
            title: notice.title,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "system_notice",
            level: notice.kind === SPEND_GUARD_STOPPED_KIND ? "error" : "warning",
            message: notice.message,
          },
        } satisfies OrchestrationV2DomainEvent,
      ],
    });
    if (notice.kind !== SPEND_GUARD_STOPPED_KIND || notice.reason !== "ceiling") return;
    for (const live of records.runs.filter(isLive)) {
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`server:spend-guard-interrupt:${threadId}:${live.id}`),
        threadId,
        runId: live.id,
        reason: notice.message,
      });
    }
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    check(threadId).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("session spend guard check failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    if (
      event.type !== "provider-turn.updated" ||
      (event.payload.turnTokenUsage === undefined && event.payload.tokenUsage === undefined) ||
      pending.has(event.threadId)
    ) {
      return Effect.void;
    }
    pending.add(event.threadId);
    return worker.enqueue(event.threadId);
  };

  const start = Effect.fn("SessionSpendGuardReactor.start")(function* () {
    yield* forkParked(Stream.runForEach(orchestrator.streamDomainEvents, processEvent));
  });

  return { start, drain: worker.drain };
});
