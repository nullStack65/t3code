import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type ThreadSeenMarker,
} from "@t3tools/contracts";
import { formatSeenMarkerForProvider } from "@t3tools/shared/seenMarker";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for dispatch decisions"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProviderReplayHarness.layerWithRegistry(
    { name: "seen-marker" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const SEEN_AT = "2026-11-20T03:00:00.000Z";

const sendWithHistory = (
  threadId: ThreadId,
  history: ReadonlyArray<readonly [string, "user" | "assistant"]>,
  seenMarker?: ThreadSeenMarker,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:seen-marker"),
      title: "Thread",
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    yield* sink.write({
      events: history.map(([id, role], index) => ({
        id: EventId.make(`event:${threadId}:${id}`),
        type: "message.updated" as const,
        threadId,
        occurredAt: now,
        payload: {
          id: MessageId.make(id),
          threadId,
          runId: null,
          nodeId: null,
          role,
          text: id,
          attachments: [],
          streaming: false,
          createdBy: role === "user" ? "user" : "agent",
          creationSource: role === "user" ? "web" : "provider",
          createdAt: DateTime.subtract(now, { seconds: history.length - index }),
          updatedAt: now,
        } satisfies OrchestrationV2ConversationMessage,
      })),
    });
    const messageId = MessageId.make(`message-next:${threadId}`);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}`),
      threadId,
      messageId,
      text: "What did I miss?",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
      ...(seenMarker ? { seenMarker } : {}),
    });
    const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
    return messages.find((message) => message.id === messageId);
  });

it.layer(layerTest)("seen marker dispatch", (it) => {
  it.effect("a send with no marker, including an MCP send, adds no catch-up", () =>
    Effect.gen(function* () {
      const sent = yield* sendWithHistory(ThreadId.make("thread:seen-none"), [
        ["message-user", "user"],
        ["message-assistant", "assistant"],
      ]);
      assert.ok(sent);
      assert.isUndefined(sent.seenMarker);
      assert.equal(
        formatSeenMarkerForProvider("What did I miss?", sent.seenMarker),
        "What did I miss?",
      );
    }),
  );

  it.effect("counts unseen assistant messages onto the message the founder sends", () =>
    Effect.gen(function* () {
      const sent = yield* sendWithHistory(
        ThreadId.make("thread:seen-count"),
        [
          ["message-user", "user"],
          ["message-assistant-1", "assistant"],
          ["message-user-2", "user"],
          ["message-assistant-2", "assistant"],
        ],
        { lastSeenMessageId: MessageId.make("message-user"), seenAt: SEEN_AT },
      );
      assert.deepEqual(sent?.seenMarker, {
        lastSeenMessageId: MessageId.make("message-user"),
        seenAt: SEEN_AT,
        unseenCount: 2,
      });
      assert.include(
        formatSeenMarkerForProvider("What did I miss?", sent?.seenMarker),
        "The user last saw message message-user; 2 messages since are unseen.",
      );
    }),
  );

  it.effect("ignores user messages and messages already seen", () =>
    Effect.gen(function* () {
      const sent = yield* sendWithHistory(
        ThreadId.make("thread:seen-later"),
        [
          ["message-user", "user"],
          ["message-assistant-1", "assistant"],
          ["message-user-2", "user"],
          ["message-assistant-2", "assistant"],
        ],
        { lastSeenMessageId: MessageId.make("message-assistant-1"), seenAt: SEEN_AT },
      );
      assert.equal(sent?.seenMarker?.unseenCount, 1);
    }),
  );

  it.effect("drops a marker the thread cannot summarize", () =>
    Effect.gen(function* () {
      const missing = yield* sendWithHistory(
        ThreadId.make("thread:seen-missing"),
        [["message-assistant", "assistant"]],
        { lastSeenMessageId: MessageId.make("missing"), seenAt: SEEN_AT },
      );
      const caughtUp = yield* sendWithHistory(
        ThreadId.make("thread:seen-caught-up"),
        [
          ["message-user", "user"],
          ["message-assistant", "assistant"],
        ],
        { lastSeenMessageId: MessageId.make("message-assistant"), seenAt: SEEN_AT },
      );
      for (const sent of [missing, caughtUp]) {
        assert.ok(sent);
        assert.isUndefined(sent.seenMarker);
      }
    }),
  );
});
