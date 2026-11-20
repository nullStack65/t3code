import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CompactionLoopGuard from "./CompactionLoopGuard.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const { CODEX_COMPACTION_LOOP_LIMIT, recordCompaction } = CompactionLoopGuard;

type OrchestrationV2Run = OrchestrationV2ThreadProjection["runs"][number];
type OrchestrationV2Message = OrchestrationV2ThreadProjection["messages"][number];

const replay = (offsetsMs: ReadonlyArray<number>) => {
  let history: ReadonlyArray<number> = [];
  return offsetsMs.map((offset) => {
    const result = recordCompaction(history, offset);
    history = result.history;
    return result.tripped;
  });
};

describe("recordCompaction", () => {
  it("defaults to three compactions within five minutes", () => {
    expect(CODEX_COMPACTION_LOOP_LIMIT.compactions).toBe(3);
    expect(CODEX_COMPACTION_LOOP_LIMIT.windowMs).toBe(300_000);
  });

  it("trips on the third compaction of a thrash sequence", () => {
    expect(replay([0, 40_000, 80_000])).toEqual([false, false, true]);
  });

  it("trips once per loop and again if the loop continues", () => {
    expect(replay([0, 30_000, 60_000, 60_005, 90_000, 120_000])).toEqual([
      false,
      false,
      true,
      false,
      false,
      true,
    ]);
  });

  it("does not trip on normally spaced compactions", () => {
    expect(replay([0, 6 * 60_000, 12 * 60_000, 18 * 60_000])).toEqual([false, false, false, false]);
  });

  it("drops compactions that fell out of the window", () => {
    expect(replay([0, 200_000, 310_000, 400_000])).toEqual([false, false, false, true]);
  });

  it("counts the paired signals of one compaction once", () => {
    expect(replay([0, 5, 60_000, 60_010])).toEqual([false, false, false, false]);
  });
});

const threadId = ThreadId.make("thread-compaction-loop");
const instanceId = ProviderInstanceId.make("codex");
const startedAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const at = (seconds: number) => DateTime.add(startedAt, { seconds });

const thread: OrchestrationV2ThreadProjection["thread"] = {
  id: threadId,
  projectId: ProjectId.make("project"),
  title: "Compaction loop",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt-5.5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdAt: at(0),
  updatedAt: at(0),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: at(0),
  deletedAt: null,
};

const emptyProjection: OrchestrationV2ThreadProjection = {
  thread,
  runs: [],
  attempts: [],
  messages: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  plans: [],
  turnItems: [],
  visibleTurnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  updatedAt: at(0),
};

const makeRun = (
  name: string,
  status: OrchestrationV2Run["status"],
  text = "Refactor the parser",
): { readonly run: OrchestrationV2Run; readonly message: OrchestrationV2Message } => {
  const runId = RunId.make(`run-${name}`);
  const messageId = MessageId.make(`message-${name}`);
  return {
    run: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: instanceId,
      modelSelection: thread.modelSelection,
      providerThreadId: null,
      userMessageId: messageId,
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: at(0),
      startedAt: at(0),
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
    message: {
      id: messageId,
      threadId,
      runId,
      nodeId: null,
      role: "user",
      text,
      attachments: [],
      streaming: false,
      createdBy: "user",
      creationSource: "web",
      createdAt: at(0),
      updatedAt: at(0),
    },
  };
};

const compacted = (
  run: OrchestrationV2Run,
  seconds: number,
  providerThread: string | null = null,
): OrchestrationV2DomainEvent => {
  const id = TurnItemId.make(`compaction-${run.id}-${seconds}-${providerThread ?? "root"}`);
  return {
    id: EventId.make(`event-${id}`),
    type: "turn-item.updated",
    threadId,
    runId: run.id,
    occurredAt: at(seconds),
    payload: {
      id,
      threadId,
      runId: run.id,
      nodeId: NodeId.make("root-node"),
      providerThreadId: providerThread === null ? null : ProviderThreadId.make(providerThread),
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: seconds,
      type: "compaction",
      driver: ProviderDriverKind.make("codex"),
      status: "completed",
      title: "Context compacted",
      startedAt: at(seconds),
      completedAt: at(seconds),
      updatedAt: at(seconds),
    },
  };
};

const replayCodexCompactions = (
  runs: ReadonlyArray<ReturnType<typeof makeRun>>,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) =>
  Effect.gen(function* () {
    const interrupts: Array<Extract<OrchestrationV2Command, { readonly type: "run.interrupt" }>> =
      [];
    const streamDone = yield* Deferred.make<void>();
    const dependencies = Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.fromIterable(events).pipe(
          Stream.ensuring(Deferred.succeed(streamDone, undefined)),
        ),
        dispatch: (command) =>
          Effect.sync(() => {
            if (command.type === "run.interrupt") interrupts.push(command);
            return { sequence: 1, storedEvents: [] };
          }),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadRecords: (_threadId, _fields, filter) =>
          Effect.succeed({
            ...emptyProjection,
            runs: runs
              .map((entry) => entry.run)
              .filter((run) => filter?.runIds?.includes(run.id) ?? true),
            messages: runs
              .map((entry) => entry.message)
              .filter(
                (message) =>
                  message.runId !== null &&
                  (filter?.messageRunIds?.includes(message.runId) ?? true),
              ),
          }),
      }),
    );
    yield* Effect.gen(function* () {
      const guard = yield* CompactionLoopGuard.make;
      yield* guard.start();
      yield* Deferred.await(streamDone);
    }).pipe(Effect.provide(dependencies));
    return interrupts;
  });

describe("CompactionLoopGuard", () => {
  it.effect("interrupts a Codex turn that compacts three times within five minutes", () =>
    Effect.gen(function* () {
      const active = makeRun("active", "running");
      const interrupts = yield* replayCodexCompactions(
        [active],
        [10, 50, 90].map((seconds) => compacted(active.run, seconds)),
      );
      expect(interrupts).toHaveLength(1);
      expect(interrupts[0]).toMatchObject({
        threadId,
        runId: active.run.id,
        reason: expect.stringContaining("will not resume on its own"),
      });
    }),
  );

  it.effect("lets a Codex turn with normally spaced compactions keep running", () =>
    Effect.gen(function* () {
      const active = makeRun("active", "running");
      const interrupts = yield* replayCodexCompactions(
        [active],
        [10, 400, 800, 1_200].map((seconds) => compacted(active.run, seconds)),
      );
      expect(interrupts).toHaveLength(0);
    }),
  );

  it.effect("counts each subagent's compactions apart from its parent turn", () =>
    Effect.gen(function* () {
      const active = makeRun("active", "running");
      const interrupts = yield* replayCodexCompactions(
        [active],
        ["subagent-a", "subagent-b", "subagent-c"].map((subagent, index) =>
          compacted(active.run, 10 + index * 20, subagent),
        ),
      );
      expect(interrupts).toHaveLength(0);
    }),
  );

  it.effect("does not count a manual compact", () =>
    Effect.gen(function* () {
      const manual = [10, 50, 90].map((seconds) => ({
        seconds,
        ...makeRun(`manual-${seconds}`, "completed", "/compact"),
      }));
      const active = makeRun("active", "running");
      const interrupts = yield* replayCodexCompactions(
        [...manual, active],
        [
          ...manual.map((entry) => compacted(entry.run, entry.seconds)),
          compacted(active.run, 100),
          compacted(active.run, 130),
        ],
      );
      expect(interrupts).toHaveLength(0);
    }),
  );

  it.effect("interrupts the next active turn after compactions that had no turn to stop", () =>
    Effect.gen(function* () {
      const finished = makeRun("finished", "completed");
      const active = makeRun("active", "running");
      const interrupts = yield* replayCodexCompactions(
        [finished, active],
        [
          ...[10, 50, 90].map((seconds) => compacted(finished.run, seconds)),
          compacted(active.run, 100),
        ],
      );
      expect(interrupts).toHaveLength(1);
      expect(interrupts[0]?.runId).toBe(active.run.id);
    }),
  );
});
