import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import {
  evaluateAgentOutputGate,
  outputGateBounceCommandId,
  outputGateBounceMessageId,
} from "./AgentOutputGate.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

interface CompletedRunSignal {
  readonly threadId: ThreadId;
  readonly runId: RunId;
}

/**
 * Enforces a 1-bounce fail-open turn-end output gate on async `origin: "agent"` wakes.
 * - Never gates `origin: "user"` turns, side chats, or subagent threads.
 * - Allows turns that already invoked an explicit channel tool (`send_to_user`, `t3_thread_send`,
 *   `ask_agent`, `silent_ack`) or emitted no plain assistant text.
 * - Issues at most 1 bounce on an unrouted plain-text turn; if the bounce still ends unrouted,
 *   fails open by stamping the output `timelineVisibility: "agent_fold"` without dropping text or
 *   bumping founder unread/attention.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  // Unbounded queue decouples stream callbacks from orchestrator dispatches (avoids transaction deadlock).
  const queue = yield* Queue.unbounded<CompletedRunSignal>();

  const stampAgentFold = Effect.fn("AgentOutputGateReactor.stampAgentFold")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
    turnItems: ReadonlyArray<
      Extract<OrchestrationV2TurnItem, { readonly type: "assistant_message" }>
    >,
  ) {
    const unstamped = turnItems.filter((item) => item.timelineVisibility === undefined);
    if (unstamped.length === 0) return;
    const now = yield* DateTime.now;
    const events = yield* Effect.forEach(unstamped, (item) =>
      Effect.gen(function* () {
        return {
          id: yield* ids.allocate.event({ threadId }),
          type: "turn-item.updated" as const,
          threadId,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: {
            ...item,
            timelineVisibility: "agent_fold" as const,
            updatedAt: now,
          },
        };
      }),
    );
    yield* eventSink.write({ events });
  });

  const evaluateCompletedRun = Effect.fn("AgentOutputGateReactor.evaluateCompletedRun")(function* (
    signal: CompletedRunSignal,
  ) {
    const records = yield* projections.getThreadRecords(
      signal.threadId,
      ["runs", "messages", "turnItems"],
      {
        runIds: [signal.runId],
        turnItemRunId: signal.runId,
      },
    );
    const run = records.runs.find((candidate) => candidate.id === signal.runId);
    if (run === undefined) return;

    const userMessage =
      run.userMessageId === null
        ? undefined
        : (records.messages.find((message) => message.id === run.userMessageId) ??
          (yield* projections.getMessagesById(signal.threadId, [run.userMessageId])).get(
            run.userMessageId,
          ));

    const decision = evaluateAgentOutputGate({
      thread: records.thread,
      run,
      userMessage,
      turnItems: records.turnItems,
      assistantMessages: records.messages,
    });

    if (decision.action === "allow") return;

    if (decision.action === "bounce") {
      yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: outputGateBounceCommandId(run.id),
          threadId: signal.threadId,
          messageId: outputGateBounceMessageId(run.id),
          text: decision.prompt,
          notification: {
            source: { kind: "system" },
            outcome: "updated",
            summary: "Output routing reminder",
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("agent output gate bounce failed; failing open", {
              threadId: signal.threadId,
              runId: run.id,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      return;
    }

    const assistantItems = records.turnItems.filter(
      (item): item is Extract<typeof item, { readonly type: "assistant_message" }> =>
        item.type === "assistant_message" && item.runId === run.id,
    );
    yield* stampAgentFold(signal.threadId, run, assistantItems).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("agent output gate fail-open fold stamp failed", {
          threadId: signal.threadId,
          runId: run.id,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const onEvent = (event: OrchestrationV2DomainEvent) =>
    event.type === "run.updated" && event.payload.status === "completed"
      ? Queue.offer(queue, { threadId: event.threadId, runId: event.payload.id }).pipe(
          Effect.asVoid,
        )
      : Effect.void;

  const processQueued = Queue.take(queue).pipe(
    Effect.flatMap((signal) =>
      evaluateCompletedRun(signal).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("agent output gate worker failed; failing open", {
              threadId: signal.threadId,
              runId: signal.runId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
    ),
    Effect.forever,
  );

  const start = Effect.fn("AgentOutputGateReactor.start")(function* () {
    yield* forkParked(orchestrator.streamDomainEvents.pipe(Stream.runForEach(onEvent)));
    yield* forkParked(processQueued);
  });

  return { start, evaluateCompletedRun };
});
