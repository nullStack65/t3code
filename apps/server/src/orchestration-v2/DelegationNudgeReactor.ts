import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type RunDelegationNudgeStats,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import {
  countedToolName,
  delegationNudgeNote,
  emptyDelegationNudgeStats,
  isDelegation,
  recordCountedTool,
} from "./DelegationNudge.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const COUNTED_TYPES = [
  "dynamic_tool",
  "command_execution",
  "file_change",
  "web_search",
  "file_search",
  "subagent",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;

interface RunWatch {
  readonly seen: Set<string>;
  stats: RunDelegationNudgeStats;
}

interface Reminder {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly note: string;
  readonly nudgesFired: number;
}

/**
 * Reminds an opted-in thread to delegate once its own run does the work. The
 * stream starts at the latest event, so a restart rebuilds a live run's counts
 * from the projection before counting anything new.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const watches = new Map<RunId, RunWatch>();
  // A plain queue, not a transactional one: the fiber that counted the tool is
  // still inside the provider batch's transaction, and a transactional offer
  // would resume its taker there. The steer then waits for that transaction to
  // commit while the commit waits for the subscriber to return.
  const reminders = yield* Queue.unbounded<Reminder>();

  const watchFor = (run: OrchestrationV2Run): RunWatch => {
    const existing = watches.get(run.id);
    if (existing !== undefined) return existing;
    const created = { seen: new Set<string>(), stats: run.delegationNudge ?? emptyDelegationNudgeStats() };
    watches.set(run.id, created);
    return created;
  };

  const record = Effect.fn("DelegationNudgeReactor.record")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
    stats: RunDelegationNudgeStats,
  ) {
    const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId }),
            type: "run.delegation-nudge-recorded",
            threadId,
            runId: run.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { runId: run.id, stats },
          },
        ],
      });
  });

  const deliver = Effect.fn("DelegationNudgeReactor.deliver")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
    stats: RunDelegationNudgeStats,
    note: string,
  ) {
      const records = yield* projections.getThreadRecords(threadId, [
        "providerThreads",
        "providerTurns",
        "providerSessions",
      ]);
      const providerThread = records.providerThreads.find((row) => row.id === run.providerThreadId);
      const turnRunning = records.providerTurns.some(
        (turn) => turn.runAttemptId === run.activeAttemptId && turn.status === "running",
      );
      // Capabilities are projected with the session, so a reminder can decide
      // without the process-local session the steer effect loads later.
      const turns = records.providerSessions.find(
        (session) => session.id === providerThread?.providerSessionId,
      )?.capabilities.turns;
      // A steer that cancels the running tool, or one the policy would turn into an
      // interrupt-and-restart, waits for the next run instead of stopping this one.
      const canSteer =
        turnRunning &&
        turns?.supportsActiveSteering === true &&
        turns.activeSteeringInterruptsTools !== true &&
        turns.supportsSteeringByInterruptRestart !== true;
      if (canSteer) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:delegation-nudge:${run.id}:${stats.nudgesFired}`),
          threadId,
          messageId: MessageId.make(`message:delegation-nudge:${run.id}:${stats.nudgesFired}`),
          text: note,
          notification: {
            source: { kind: "system" },
            outcome: "updated",
            summary: "Delegation reminder",
          },
          attachments: [],
          // Queued, like every other server notice: the planner refuses a
          // notification that arrives already steering, then steers this one
          // into the running turn when the provider can take it.
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        });
        // The note reached this turn, so the next run must not carry it again.
        const { deferredNote: _delivered, ...delivered } = stats;
        return { ...delivered, deferredNote: undefined };
      }
      return { ...stats, deferredNote: note };
  });

  const consider = Effect.fn("DelegationNudgeReactor.consider")(function* (
    threadId: ThreadId,
    runId: RunId,
    item: OrchestrationV2TurnItem | null,
  ) {
    const records = yield* projections.getThreadRecords(threadId, ["runs"]);
    const setting = records.thread.delegationNudge;
    if (setting?.enabled !== true) return;
    const run = records.runs.find((candidate) => candidate.id === runId);
    if (run === undefined || (run.status !== "running" && run.status !== "starting")) return;
    const watch = watchFor(run);
    if (watch.seen.size === 0 && run.delegationNudge === undefined) {
      const prior = yield* projections.getThreadRecords(threadId, ["turnItems"], {
        turnItemRunId: run.id,
        turnItemTypes: [...COUNTED_TYPES],
      });
      for (const existing of prior.turnItems) apply(watch, existing);
    }
    if (item !== null) apply(watch, item);
    const threshold = setting.thresholds[watch.stats.nudgesFired];
    if (
      threshold === undefined ||
      watch.stats.delegations > 0 ||
      watch.stats.countedToolCalls < threshold
    ) {
      if (item !== null) yield* record(threadId, run, watch.stats);
      return;
    }
    const note = delegationNudgeNote(threshold, watch.stats.nudgesFired > 0);
    watch.stats = { ...watch.stats, nudgesFired: watch.stats.nudgesFired + 1, deferredNote: note };
    yield* record(threadId, run, watch.stats);
    // Recorded before delivery so a crash keeps the note for the next run.
    // Offered after the commit: offering now runs on the fiber ingesting the
    // provider batch, and the steer it starts would wait for that batch.
    yield* sql.afterCommit(
      Queue.offer(reminders, {
        threadId,
        runId: run.id,
        note,
        nudgesFired: watch.stats.nudgesFired,
      }).pipe(Effect.asVoid),
    );
  });

  const deliverReminder = Effect.fn("DelegationNudgeReactor.deliverReminder")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly note: string;
    readonly nudgesFired: number;
  }) {
    const records = yield* projections.getThreadRecords(input.threadId, ["runs"]);
    const run = records.runs.find((candidate) => candidate.id === input.runId);
    const watch = run === undefined ? undefined : watches.get(run.id);
    if (run === undefined || watch === undefined || watch.stats.nudgesFired !== input.nudgesFired) {
      return;
    }
    const stats = yield* deliver(input.threadId, run, watch.stats, input.note);
    if (stats.deferredNote === watch.stats.deferredNote) return;
    watch.stats = stats;
    yield* record(input.threadId, run, stats);
  });

  const worker = yield* makeDrainableWorker(
    (input: { readonly threadId: ThreadId; readonly runId: RunId; readonly item: OrchestrationV2TurnItem | null }) =>
      consider(input.threadId, input.runId, input.item).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("delegation nudge check failed", {
              threadId: input.threadId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  );

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    if (event.type === "turn-item.updated" && event.runId !== undefined) {
      const item = event.payload;
      if (!COUNTED_TYPES.includes(item.type as (typeof COUNTED_TYPES)[number])) return Effect.void;
      return worker.enqueue({ threadId: event.threadId, runId: event.runId, item });
    }
    if (event.type === "run.updated" && event.payload.status === "running") {
      return worker.enqueue({ threadId: event.threadId, runId: event.payload.id, item: null });
    }
    if (
      event.type === "run.updated" &&
      !["running", "starting", "preparing", "queued", "waiting"].includes(event.payload.status)
    ) {
      watches.delete(event.payload.id);
    }
    return Effect.void;
  };

  // Forked at startup, so it never joins the provider batch's transaction the
  // way a fiber forked from the counting subscriber would.
  const deliverQueued = Queue.take(reminders).pipe(
    Effect.andThen((reminder) =>
      deliverReminder(reminder).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("delegation nudge delivery failed", {
              threadId: reminder.threadId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
    ),
    Effect.forever,
  );

  const start = Effect.fn("DelegationNudgeReactor.start")(function* () {
    yield* forkParked(orchestrator.streamDomainEvents.pipe(Stream.runForEach(processEvent)));
    yield* forkParked(deliverQueued);
  });

  return { start, drain: worker.drain };
});

function apply(watch: RunWatch, item: OrchestrationV2TurnItem): void {
  if (watch.seen.has(item.id)) return;
  watch.seen.add(item.id);
  if (isDelegation(item)) {
    watch.stats = { ...watch.stats, delegations: watch.stats.delegations + 1 };
    return;
  }
  const name = countedToolName(item);
  if (name !== null) watch.stats = recordCountedTool(watch.stats, name);
}

