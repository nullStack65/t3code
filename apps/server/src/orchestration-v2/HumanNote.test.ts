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
      const human = yield* orchestrator.getThreadSnapshot(threadId);
      assert.include(JSON.stringify(human), "please look @Jeff");
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

  it.effect(
    "promotes one stored note after rejection and deduplicates concurrent submissions",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = ThreadId.make("thread:promote-note");
        const noteId = MessageId.make("note:source");
        const text = "synthetic promotion text";
        yield* createThread(threadId);
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          threadId,
          commandId: CommandId.make("share:promote"),
          inboxRouting: {
            owner: null,
            assignee: null,
            audience: "shared",
            attentionKind: "FYI",
            reason: "conversation",
          },
        });
        const send = (id: string, creationSource: "web" | "mobile" = "mobile") => ({
          type: "message.dispatch" as const,
          threadId,
          commandId: CommandId.make(`dispatch:${id}`),
          messageId: MessageId.make(id),
          text: "",
          attachments: [],
          dispatchMode: { type: "promote_human_note" as const, noteId },
          createdBy: "user" as const,
          creationSource,
          sentBy: sentBy("jeff"),
        });
        yield* orchestrator.dispatch({
          ...send("record", "web"),
          messageId: noteId,
          text,
          humanNote: true,
          sentBy: sentBy("kameron"),
          dispatchMode: { type: "queue_after_active" },
        });
        assert.deepEqual(yield* projections.getTurnStartHistory(threadId), []);
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive:note"),
          threadId,
        });
        const refused = yield* orchestrator.dispatch(send("rejected")).pipe(Effect.flip);
        assert.equal(refused._tag, "OrchestratorDispatchError");
        yield* orchestrator.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("unarchive:note"),
          threadId,
        });
        yield* Effect.all(
          [orchestrator.dispatch(send("retry-1")), orchestrator.dispatch(send("retry-2"))],
          { concurrency: 2 },
        );
        yield* orchestrator.dispatch(send("repeat", "web"));
        const snapshot = yield* projections.getThreadProjection(threadId);
        assert.equal(snapshot.runs.length, 1);
        assert.equal(snapshot.messages.length, 2);
        const note = snapshot.messages.find((message) => message.id === noteId);
        assert.equal(note?.text, text);
        assert.equal(note?.sentBy?.founder, "kameron");
        const promoted = snapshot.messages.find((message) => message.id !== noteId);
        assert.equal(promoted?.text, text);
        assert.equal(promoted?.humanNote, undefined);
        assert.equal(promoted?.sentBy?.founder, "jeff");
        assert.equal(promoted?.creationSource, "mobile");
        const history = yield* projections.getTurnStartHistory(threadId);
        assert.deepEqual(
          history.flatMap((item) => (item.type === "user_message" ? [item.text] : [])),
          [text],
        );
        const noteRow = (yield* orchestrator.getThreadSnapshot(
          threadId,
        )).projection.visibleTurnItems.find(
          ({ item }) => item.type === "user_message" && item.messageId === noteId,
        );
        assert.equal(
          noteRow?.item.type === "user_message" ? noteRow.item.humanNotePromoted : undefined,
          true,
        );
        const ordinary = {
          ...send("ordinary", "web"),
          text,
          dispatchMode: { type: "queue_after_active" as const },
        };
        yield* orchestrator.dispatch(ordinary);
        assert.equal((yield* projections.getThreadProjection(threadId)).messages.length, 3);
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
