import { CommandId, EventId, type OrchestrationEvent, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  CONTEXT_WINDOW_KIND,
  describeSpendStop,
  evaluateThreadSpend,
  SPEND_GUARD_ACTIVITY_KINDS,
  SPEND_GUARD_FLAGGED_KIND,
  SPEND_GUARD_STOPPED_KIND,
} from "./SessionSpendGuard.ts";

export class SessionSpendGuardReactor extends Context.Service<
  SessionSpendGuardReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/SessionSpendGuardReactor") {}

const usd = (value: number) => Math.round(value * 100) / 100;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const pending = new Set<ThreadId>();

  const appendGuardActivity = Effect.fn("SessionSpendGuardReactor.appendGuardActivity")(function* (
    threadId: ThreadId,
    kind: string,
    summary: string,
    payload: Record<string, unknown>,
  ) {
    const uuid = yield* crypto.randomUUIDv4;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`server:spend-guard:${threadId}:${uuid}`),
      threadId,
      activity: {
        id: EventId.make(`spend-guard:${uuid}`),
        tone: "error",
        kind,
        summary,
        payload,
        turnId: null,
        createdAt,
      },
      createdAt,
    });
  });

  const check = Effect.fn("SessionSpendGuardReactor.check")(function* (threadId: ThreadId) {
    pending.delete(threadId);
    const settings = yield* settingsService.getSettings;
    if (settings.sessionSpendGuard.mode === "off") return;
    const thread = yield* snapshots.getThreadDetailById(threadId, {
      activityKinds: SPEND_GUARD_ACTIVITY_KINDS,
      unboundedActivities: true,
    });
    if (Option.isNone(thread)) return;
    const evaluation = evaluateThreadSpend(thread.value, settings);
    const amounts = {
      sessionUsd: usd(evaluation.sessionUsd),
      idleUsd: usd(evaluation.idleUsd),
      idleSince: evaluation.idleSince,
    };
    if (evaluation.level === "stop") {
      const alreadyStopped =
        evaluation.stopReason === "ceiling"
          ? evaluation.stoppedForCeiling
          : evaluation.stoppedSinceIdle;
      if (alreadyStopped) return;
      yield* appendGuardActivity(
        threadId,
        SPEND_GUARD_STOPPED_KIND,
        evaluation.stopReason === "ceiling"
          ? "Stopped: session spend ceiling reached"
          : "Stopped: spending with no pull request or file changes",
        {
          ...amounts,
          reason: evaluation.stopReason,
          detail: describeSpendStop(evaluation, settings.sessionSpendGuard),
        },
      );
      const session = thread.value.session;
      if (
        evaluation.stopReason === "ceiling" &&
        session !== null &&
        (session.status === "running" || session.status === "starting")
      ) {
        const uuid = yield* crypto.randomUUIDv4;
        yield* engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make(`server:spend-guard-interrupt:${threadId}:${uuid}`),
          threadId,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
      }
      return;
    }
    if (evaluation.level === "flag" && evaluation.stopReason === "ceiling") {
      if (evaluation.flaggedForCeiling) return;
      yield* appendGuardActivity(
        threadId,
        SPEND_GUARD_FLAGGED_KIND,
        "Session spend ceiling reached",
        {
          ...amounts,
          reason: "ceiling",
          detail: describeSpendStop(evaluation, settings.sessionSpendGuard),
        },
      );
      return;
    }
    if (evaluation.level === "flag" && !evaluation.flaggedSinceIdle) {
      yield* appendGuardActivity(
        threadId,
        SPEND_GUARD_FLAGGED_KIND,
        "Spending with no pull request or file changes",
        {
          ...amounts,
          reason: "idle",
          detail: `This thread has spent about $${amounts.idleUsd.toFixed(2)} since its last linked pull request or file-changing turn. It stops at $${settings.sessionSpendGuard.idleStopUsd.toFixed(2)}.`,
        },
      );
    }
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    check(threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("session spend guard check failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationEvent) => {
    if (
      event.type !== "thread.activity-appended" ||
      event.payload.activity.kind !== CONTEXT_WINDOW_KIND ||
      pending.has(event.payload.threadId)
    ) {
      return Effect.void;
    }
    pending.add(event.payload.threadId);
    return worker.enqueue(event.payload.threadId);
  };

  const start: SessionSpendGuardReactor["Service"]["start"] = Effect.fn(
    "SessionSpendGuardReactor.start",
  )(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
  });

  return { start, drain: worker.drain } satisfies SessionSpendGuardReactor["Service"];
});

export const layer = Layer.effect(SessionSpendGuardReactor, make);
