import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { formatSeenMarkerForProvider } from "@t3tools/shared/seenMarker";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-11-20T03:00:00.000Z";

function message(id: string, role: "user" | "assistant"): OrchestrationThread["messages"][number] {
  return {
    id: MessageId.make(id),
    role,
    text: id,
    turnId: null,
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  } as OrchestrationThread["messages"][number];
}

function makeReadModel(
  messages: ReadonlyArray<OrchestrationThread["messages"][number]>,
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: [...messages],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

function turnStart(seenMarker?: {
  lastSeenMessageId: ReturnType<typeof MessageId.make>;
  seenAt: string;
}) {
  return {
    type: "thread.turn.start" as const,
    commandId: CommandId.make("cmd-turn"),
    threadId: ThreadId.make("thread-1"),
    message: {
      messageId: MessageId.make("message-next"),
      role: "user" as const,
      text: "What did I miss?",
      attachments: [],
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    ...(seenMarker ? { seenMarker } : {}),
    createdAt: NOW,
  };
}

it.layer(NodeServices.layer)("seen marker decider", (it) => {
  it.effect("a send with no marker, including an MCP send, adds no catch-up", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: turnStart(),
        readModel: makeReadModel([
          message("message-user", "user"),
          message("message-assistant", "assistant"),
        ]),
      });
      const events = Array.isArray(result) ? result : [result];
      const start = events.find((event) => event.type === "thread.turn-start-requested");
      expect(start?.type).toBe("thread.turn-start-requested");
      if (start?.type !== "thread.turn-start-requested") return;
      expect(start.payload.seenMarker).toBeUndefined();
      expect(formatSeenMarkerForProvider("What did I miss?", start.payload.seenMarker)).toBe(
        "What did I miss?",
      );
    }),
  );

  it.effect("counts unseen assistant messages onto the turn the founder sends", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: turnStart({
          lastSeenMessageId: MessageId.make("message-user"),
          seenAt: NOW,
        }),
        readModel: makeReadModel([
          message("message-user", "user"),
          message("message-assistant-1", "assistant"),
          message("message-user-2", "user"),
          message("message-assistant-2", "assistant"),
        ]),
      });
      const events = Array.isArray(result) ? result : [result];
      const start = events.find((event) => event.type === "thread.turn-start-requested");
      if (start?.type !== "thread.turn-start-requested") {
        expect(start?.type).toBe("thread.turn-start-requested");
        return;
      }
      expect(start.payload.seenMarker).toEqual({
        lastSeenMessageId: MessageId.make("message-user"),
        seenAt: NOW,
        unseenCount: 2,
      });
      expect(formatSeenMarkerForProvider("What did I miss?", start.payload.seenMarker)).toContain(
        "The user last saw message message-user; 2 messages since are unseen.",
      );
    }),
  );

  it.effect("drops a marker the thread cannot summarize", () =>
    Effect.gen(function* () {
      const missing = yield* decideOrchestrationCommand({
        command: turnStart({
          lastSeenMessageId: MessageId.make("missing"),
          seenAt: NOW,
        }),
        readModel: makeReadModel([message("message-assistant", "assistant")]),
      });
      const caughtUp = yield* decideOrchestrationCommand({
        command: turnStart({
          lastSeenMessageId: MessageId.make("message-assistant"),
          seenAt: NOW,
        }),
        readModel: makeReadModel([
          message("message-user", "user"),
          message("message-assistant", "assistant"),
        ]),
      });
      for (const result of [missing, caughtUp]) {
        const events = Array.isArray(result) ? result : [result];
        const start = events.find((event) => event.type === "thread.turn-start-requested");
        if (start?.type !== "thread.turn-start-requested") {
          expect(start?.type).toBe("thread.turn-start-requested");
          return;
        }
        expect(start.payload.seenMarker).toBeUndefined();
      }
    }),
  );
});
