import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("A note must not start a provider session"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "human-note" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const sentBy = (founder: "kameron" | "jeff") => ({
  sessionId: AuthSessionId.make(`session:${founder}`),
  device: "laptop",
  deviceType: "desktop" as const,
  founder,
});

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:human-note"),
      title: "Before",
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

it.layer(layerTest)("human notes", (it) => {
  it.effect("records a shared note, signs only that founder, and starts no run", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:human-note");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:human-note"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("share:human-note"),
        threadId,
        inboxRouting: {
          owner: null,
          assignee: null,
          audience: "shared",
          attentionKind: "FYI",
          reason: "decision",
        },
        decisionRequest: {
          founder: "kameron",
          kind: "decision",
          question: "Ship it?",
          signOff: [
            { founder: "kameron", signed: false },
            { founder: "jeff", signed: false },
          ],
        },
      });
      yield* TestClock.adjust("20 millis");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("note:kameron"),
        threadId,
        messageId: MessageId.make("message:note:kameron"),
        text: "  please look @Jeff  ",
        attachments: [],
        humanNote: true,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
        sentBy: sentBy("kameron"),
      });
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.runs.length, 0);
      assert.equal(projection.messages.length, 1);
      assert.equal(projection.messages[0]?.text, "please look @Jeff");
      assert.equal(projection.messages[0]?.humanNote, true);
      assert.equal(projection.messages[0]?.runId, null);
      const note = projection.turnItems.find((item) => item.type === "user_message");
      assert.equal(note?.type === "user_message" ? note.humanNote : undefined, true);
      assert.equal(note?.status, "completed");
      assert.deepEqual(yield* projections.getTurnStartHistory(threadId), []);
      const shell = yield* projections.getThreadShell(threadId);
      assert.equal(shell?.settledOverride, null);
      assert.deepEqual(shell?.attentionMentions, ["jeff"]);
      assert.deepEqual(shell?.inbox?.decisionRequest?.signOff, [
        { founder: "kameron", signed: true },
        { founder: "jeff", signed: false },
      ]);

      yield* TestClock.adjust("20 millis");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("note:jeff"),
        threadId,
        messageId: MessageId.make("message:note:jeff"),
        text: "signed",
        attachments: [],
        humanNote: true,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
        sentBy: sentBy("jeff"),
      });
      const closed = yield* projections.getThreadShell(threadId);
      assert.equal(closed?.inbox?.decisionRequest, undefined);
      assert.equal((yield* projections.getThreadProjection(threadId)).runs.length, 0);
      assert.deepEqual(yield* projections.getTurnStartHistory(threadId), []);
    }),
  );

  it.effect("rejects a note off a shared thread without waking it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:human-note-private");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:private"),
        threadId,
      });
      const refused = yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("note:private"),
          threadId,
          messageId: MessageId.make("message:note:private"),
          text: "just us",
          attachments: [],
          humanNote: true,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
          sentBy: sentBy("kameron"),
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");
      const shell = yield* projections.getThreadShell(threadId);
      assert.equal(shell?.title, "Before");
      assert.equal(shell?.settledOverride, "settled");
      assert.equal((yield* projections.getThreadProjection(threadId)).messages.length, 0);
    }),
  );
});
