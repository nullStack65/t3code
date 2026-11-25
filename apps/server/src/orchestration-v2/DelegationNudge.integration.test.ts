import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

const harness = Effect.fn("delegationNudgeHarness")(function* (
  name: string,
  turns: {
    readonly supportsSteeringByInterruptRestart?: boolean;
    readonly activeSteeringInterruptsTools?: boolean;
  },
) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: string[] = [];
  const steered: string[] = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: { ...CodexProviderCapabilitiesV2.turns, ...turns },
  };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              started.push(turn.message.text);
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              });
            }),
          steerTurn: (turn) => Effect.sync(() => void steered.push(turn.message.text)),
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerSingle(adapter),
  );
  const startFirstTurn = Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "Delegation nudge",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "do the work",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const running = yield* watch(
      orchestrator,
      (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
    );
    yield* worker.drain();
    yield* Fiber.join(running);
    return threadId;
  });
  return { events, started, steered, layer, startFirstTurn };
});

const watch = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  predicate: (event: OrchestrationV2DomainEvent) => boolean,
) =>
  orchestrator.streamDomainEvents.pipe(
    Stream.filter(predicate),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkScoped,
  );

const rootNodeId = (run: { readonly rootNodeId: NodeId | null }): NodeId => {
  assert.notEqual(run.rootNodeId, null);
  return run.rootNodeId!;
};

const tool = (
  threadId: ThreadId,
  runId: NonNullable<OrchestrationV2TurnItem["runId"]>,
  nodeId: NodeId,
  providerThreadId: NonNullable<OrchestrationV2TurnItem["providerThreadId"]>,
  providerTurnId: NonNullable<OrchestrationV2TurnItem["providerTurnId"]>,
  id: string,
  name: string,
  now: DateTime.Utc,
) =>
  ({
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: TurnItemId.make(id),
      threadId,
      runId,
      nodeId,
      providerThreadId,
      providerTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "dynamic_tool",
      toolName: name,
      input: {},
    },
  }) satisfies ProviderAdapter.ProviderAdapterV2Event;

const completeTurn = (
  events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>,
  turn: OrchestrationV2ProviderTurn,
  runOrdinal: number,
  now: DateTime.Utc,
) =>
  Effect.all(
    [
      Queue.offer(events, {
        type: "provider_turn.updated",
        driver,
        providerTurn: { ...turn, status: "completed", completedAt: now },
      }),
      Queue.offer(events, {
        type: "turn.terminal",
        driver,
        providerThreadId: turn.providerThreadId,
        providerTurnId: turn.id,
        runOrdinal,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      }),
    ],
    { discard: true },
  );

it.effect("steers a capable provider at the first threshold and stays quiet after a delegation", () =>
  Effect.gen(function* () {
    const { events, steered, layer, startFirstTurn } = yield* harness("nudge-steer", {
      supportsSteeringByInterruptRestart: false,
    });
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = yield* startFirstTurn;
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const run = projection.runs[0]!;
      const turn = projection.providerTurns[0]!;
      yield* orchestrator.dispatch({
        type: "thread.delegation-nudge.set",
        commandId: CommandId.make("enable"),
        threadId,
        enabled: true,
      });
      const now = yield* DateTime.now;
      const offer = (id: string, name: string) =>
        Queue.offer(
          events,
          tool(threadId, run.id, rootNodeId(run), turn.providerThreadId, turn.id, id, name, now),
        );
      const steeredEvent = yield* watch(
        orchestrator,
        (event) => event.type === "message.updated" && event.payload.text.includes("tool calls"),
      );
      for (const index of [1, 2, 3, 4, 5]) yield* offer(`tool-${index}`, "Read");
      yield* Fiber.join(steeredEvent);
      yield* worker.drain();
      assert.equal(steered.length, 1);
      assert.match(steered[0]!, /5 tool calls/);
      const delegated = yield* watch(
        orchestrator,
        (event) =>
          event.type === "run.delegation-nudge-recorded" && event.payload.stats.delegations === 1,
      );
      yield* offer("tool-6", "mcp__t3-code__delegate_task");
      for (const index of [7, 8, 9, 10]) yield* offer(`tool-${index}`, "Read");
      yield* Fiber.join(delegated);
      const stats = (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.delegationNudge;
      assert.equal(stats?.nudgesFired, 1);
      assert.equal(stats?.delegations, 1);
      assert.equal(stats?.deferredNote, undefined);
      assert.equal(steered.length, 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("defers the note when steering would interrupt the running tool", () =>
  Effect.gen(function* () {
    const { events, started, steered, layer, startFirstTurn } = yield* harness("nudge-defer", {
      activeSteeringInterruptsTools: true,
    });
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = yield* startFirstTurn;
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const run = projection.runs[0]!;
      const turn = projection.providerTurns[0]!;
      yield* orchestrator.dispatch({
        type: "thread.delegation-nudge.set",
        commandId: CommandId.make("enable"),
        threadId,
        enabled: true,
        thresholds: [1],
      });
      const now = yield* DateTime.now;
      const recorded = yield* watch(
        orchestrator,
        (event) => event.type === "run.delegation-nudge-recorded",
      );
      yield* Queue.offer(
        events,
        tool(threadId, run.id, rootNodeId(run), turn.providerThreadId, turn.id, "tool-1", "Bash", now),
      );
      yield* Fiber.join(recorded);
      const note = (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.delegationNudge;
      assert.equal(steered.length, 0);
      assert.match(note?.deferredNote ?? "", /1 tool call/);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("second"),
        threadId,
        messageId: MessageId.make("message:second"),
        text: "continue",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      const next = yield* watch(
        orchestrator,
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      );
      yield* completeTurn(events, turn, run.ordinal, now);
      yield* worker.drain();
      yield* orchestrator.resumeQueuedRuns;
      yield* worker.drain();
      yield* Fiber.join(next);
      assert.equal(steered.length, 0);
      assert.equal(started.filter((text) => text.includes("delegate_task")).length, 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("does not count orchestrator tools and stays off by default", () =>
  Effect.gen(function* () {
    const { events, steered, layer, startFirstTurn } = yield* harness("nudge-exclude", {
      supportsSteeringByInterruptRestart: false,
    });
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = yield* startFirstTurn;
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const run = projection.runs[0]!;
      const turn = projection.providerTurns[0]!;
      const now = yield* DateTime.now;
      const offer = (id: string, name: string) =>
        Queue.offer(
          events,
          tool(threadId, run.id, rootNodeId(run), turn.providerThreadId, turn.id, id, name, now),
        );
      for (const [index, name] of [
        "mcp__t3-code__task_status",
        "t3-code.orchestrator_capabilities",
        "t3_thread_read",
      ].entries()) {
        yield* offer(`orch-${index}`, name);
      }
      const ingested = yield* watch(
        orchestrator,
        (event) => event.type === "turn-item.updated" && event.payload.id === "orch-2",
      );
      yield* Fiber.join(ingested);
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.delegationNudge,
        undefined,
      );
      assert.equal(steered.length, 0);
      yield* orchestrator.dispatch({
        type: "thread.delegation-nudge.set",
        commandId: CommandId.make("enable"),
        threadId,
        enabled: true,
        thresholds: [1],
        changedBy: { kind: "agent", threadId: ThreadId.make("thread:other") },
      });
      const setting = (yield* orchestrator.getThreadProjection(threadId)).thread.delegationNudge;
      assert.equal(setting?.changedBy.kind, "agent");
      const recorded = yield* watch(
        orchestrator,
        (event) => event.type === "run.delegation-nudge-recorded",
      );
      yield* offer("real", "Read");
      yield* Fiber.join(recorded);
      const stats = (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.delegationNudge;
      assert.equal(stats?.countedToolCalls, 1);
      assert.deepEqual(stats?.topTools, [{ name: "Read", count: 1 }]);
    }).pipe(Effect.provide(layer));
  }),
);
