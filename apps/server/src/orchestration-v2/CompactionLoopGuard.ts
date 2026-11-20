import {
  CommandId,
  isCompactionCommandMessage,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { isActiveRun } from "./CommandPolicy.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export const CODEX_COMPACTION_LOOP_LIMIT = {
  compactions: 3,
  windowMs: 5 * 60_000,
  duplicateSignalMs: 2_000,
} as const;

export type CompactionLoopLimit = {
  readonly compactions: number;
  readonly windowMs: number;
  readonly duplicateSignalMs: number;
};

export function recordCompaction(
  history: ReadonlyArray<number>,
  atMs: number,
  limit: CompactionLoopLimit = CODEX_COMPACTION_LOOP_LIMIT,
): { readonly history: ReadonlyArray<number>; readonly tripped: boolean } {
  const last = history.at(-1);
  if (last !== undefined && Math.abs(atMs - last) < limit.duplicateSignalMs) {
    return { history, tripped: false };
  }
  const recent = [...history.filter((at) => atMs - at < limit.windowMs), atMs];
  const tripped = recent.length >= limit.compactions;
  return { history: tripped ? [atMs] : recent, tripped };
}

function describeCompactionLoop(limit: CompactionLoopLimit = CODEX_COMPACTION_LOOP_LIMIT) {
  const minutes = limit.windowMs / 60_000;
  return `Context compacted ${limit.compactions} times within ${minutes} minute${minutes === 1 ? "" : "s"}, so the turn was stopped instead of re-reading the full context again. It will not resume on its own. Send a new message, ideally with a narrower request, to continue.`;
}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const historyByConversation = new Map<string, ReadonlyArray<number>>();

  const handle = Effect.fn("CompactionLoopGuard.handle")(
    function* (event: OrchestrationV2DomainEvent) {
      if (event.type !== "turn-item.updated") return;
      const item = event.payload;
      if (
        item.type !== "compaction" ||
        item.driver !== "codex" ||
        item.status !== "completed" ||
        item.runId === null
      )
        return;
      const records = yield* projections.getThreadRecords(item.threadId, ["runs", "messages"], {
        runIds: [item.runId],
        messageRunIds: [item.runId],
      });
      const run = records.runs.find((candidate) => candidate.id === item.runId);
      if (run === undefined) return;
      const message = records.messages.find((candidate) => candidate.id === run.userMessageId);
      if (message !== undefined && isCompactionCommandMessage(message)) return;
      const conversation = `${item.threadId}\u0000${item.providerThreadId ?? ""}`;
      const previous = historyByConversation.get(conversation) ?? [];
      const atMs = DateTime.toEpochMillis(item.completedAt ?? item.updatedAt);
      const result = recordCompaction(previous, atMs);
      if (result.tripped && !isActiveRun(run)) {
        historyByConversation.set(conversation, [
          ...previous.filter((at) => atMs - at < CODEX_COMPACTION_LOOP_LIMIT.windowMs),
          atMs,
        ]);
        return;
      }
      historyByConversation.set(conversation, result.history);
      if (!result.tripped) return;
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`server:compaction-loop:${item.threadId}:${item.id}`),
        threadId: item.threadId,
        runId: run.id,
        reason: describeCompactionLoop(),
      });
    },
    (effect) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logWarning("compaction loop guard failed", { cause }),
        ),
      ),
  );

  const start = Effect.fn("CompactionLoopGuard.start")(function* () {
    yield* forkParked(Stream.runForEach(orchestrator.streamDomainEvents, handle));
  });
  return { start };
});
