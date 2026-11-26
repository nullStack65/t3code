import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { withExplicitTimelineVisibility } from "./timelineVisibility.ts";

type DynamicToolItem = Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;

const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const threadId = ThreadId.make("thread-visibility");

const toolItem = (
  overrides: Partial<Omit<DynamicToolItem, "id">> & { id: string },
): DynamicToolItem => ({
  type: "dynamic_tool",
  threadId,
  runId: RunId.make("agent-run"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: now,
  toolName: "mcp__t3-code__send_to_user",
  input: { message: "Draft ready" },
  output: { sentMessage: "Draft ready", message: "Shown to the user. Don't repeat it." },
  ...overrides,
  id: TurnItemId.make(overrides.id),
});

it("stamps a finished send_to_user call so an agent run cannot fold it", () => {
  const stamped = withExplicitTimelineVisibility(toolItem({ id: "sent" }));
  assert.equal(stamped.timelineVisibility, "user_timeline");
});

it("leaves other tool calls, unfinished calls, failures and existing stamps alone", () => {
  const other = toolItem({
    id: "other",
    toolName: "mcp__t3-code__t3_thread_read",
    output: { threads: [] },
  });
  assert.strictEqual(withExplicitTimelineVisibility(other), other);
  const running = toolItem({ id: "running", status: "running", output: undefined });
  assert.strictEqual(withExplicitTimelineVisibility(running), running);
  const failed = toolItem({
    id: "failed",
    output: { isError: true, sentMessage: "Draft ready" },
  });
  assert.strictEqual(withExplicitTimelineVisibility(failed), failed);
  const folded = toolItem({ id: "folded", timelineVisibility: "agent_fold" });
  assert.strictEqual(withExplicitTimelineVisibility(folded), folded);
});

const layer = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provide(Sqlite.layerMemory),
);

it.effect("persists the stamp for every adapter through the event sink", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const providerInstanceId = ProviderInstanceId.make("codex");
    const thread: OrchestrationV2AppThread = {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Visibility",
      createdBy: "agent",
      creationSource: "mcp",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      lastVisitedAt: null,
    };
    const sent = toolItem({ id: "sent" });
    const read = toolItem({
      id: "read",
      ordinal: 1,
      toolName: "mcp__t3-code__t3_thread_read",
      output: { threads: [] },
    });
    yield* sink.write({
      events: [
        {
          id: EventId.make("thread-created"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        },
        ...[sent, read].map((item) => ({
          id: EventId.make(`event-${item.id}`),
          type: "turn-item.updated" as const,
          threadId,
          occurredAt: now,
          payload: item,
        })),
      ],
    });
    const storedSent = yield* projections.getTurnItem({ threadId, itemId: sent.id });
    const storedRead = yield* projections.getTurnItem({ threadId, itemId: read.id });
    assert.equal(storedSent?.timelineVisibility, "user_timeline");
    assert.equal(storedRead?.timelineVisibility, undefined);
  }).pipe(Effect.provide(layer)),
);
