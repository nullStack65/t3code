import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  applyCollaborationUpdate,
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ThreadId,
  type ThreadMetadataMcpUpdateInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";

const room = ThreadId.make("thread-room");
const growth = ThreadId.make("thread-growth");
const cfo = ThreadId.make("thread-cfo");
const gone = ThreadId.make("thread-gone");
const deleted = ThreadId.make("thread-deleted");
const NOW = "2026-11-24T15:00:00.000Z";

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-room-test"),
  requestNamespace: "provider-session-room-test",
  thread: {
    threadId: room,
    providerSessionId: "provider-session-room-test",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const shell = (id: ThreadId, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    id,
    title: id,
    titleRegeneration: null,
    linkedPullRequest: null,
    updatedAt: DateTime.makeUnsafe(NOW),
    deletedAt: null,
    ...overrides,
  }) as OrchestrationV2ThreadShell;

/**
 * The service against an in-memory thread table whose dispatch applies the collaboration update.
 * Like the orchestrator, a repeated command id replays the first receipt without applying again.
 */
const makeHarness = () => {
  const threads = new Map<ThreadId, OrchestrationV2ThreadShell>([
    [room, shell(room)],
    [growth, shell(growth)],
    [cfo, shell(cfo)],
    [deleted, shell(deleted, { deletedAt: DateTime.makeUnsafe(NOW) })],
  ]);
  const dispatched: OrchestrationV2ServerCommand[] = [];
  const receipts = new Map<string, number>();
  const layer = ThreadMetadataMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(threads.get(threadId) ?? null),
          dispatch: (command) =>
            Effect.sync(() => {
              const replayed = receipts.get(command.commandId);
              if (replayed !== undefined) return { sequence: replayed, storedEvents: [] };
              dispatched.push(command);
              receipts.set(command.commandId, dispatched.length);
              if (command.type === "thread.metadata.update" && command.collaboration) {
                const current = threads.get(command.threadId)!;
                threads.set(command.threadId, {
                  ...current,
                  collaboration: applyCollaborationUpdate(
                    current.collaboration,
                    command.collaboration,
                    NOW,
                  ),
                });
              }
              // No stored events: the service answers from the projection, as on a retry.
              return { sequence: dispatched.length, storedEvents: [] };
            }),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );
  const update = (input: ThreadMetadataMcpUpdateInput) =>
    Effect.gen(function* () {
      const service = yield* ThreadMetadataMcpService.ThreadMetadataMcpService;
      return yield* service.update(scope, input);
    }).pipe(Effect.provide(layer));
  return { dispatched, update };
};

const openRoom = (members: ReadonlyArray<ThreadId>): ThreadMetadataMcpUpdateInput => ({
  action: "collaborate",
  collaboration: {
    type: "open_room",
    room: { topic: "How we set up Growth", members, linearIssue: "ENG-123" },
  },
});

describe("t3_thread_update collaborate", () => {
  it.effect("refuses a room member that does not exist or was deleted, before dispatching", () =>
    Effect.gen(function* () {
      const { dispatched, update } = makeHarness();
      const missing = yield* Effect.flip(update(openRoom([growth, gone])));
      expect(missing.code).toBe("invalid_request");
      expect(missing.message).toBe(`Room member ${gone} was not found.`);
      const removed = yield* Effect.flip(update(openRoom([deleted, cfo])));
      expect(removed.message).toBe(`Room member ${deleted} was not found.`);
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("refuses the room thread as its own member", () =>
    Effect.gen(function* () {
      const { dispatched, update } = makeHarness();
      const error = yield* Effect.flip(update(openRoom([room, growth])));
      expect(error.code).toBe("invalid_request");
      expect(error.message).toMatch(/the room thread itself facilitates/);
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("opens a room, then closes it once and returns the Linear and memory record", () =>
    Effect.gen(function* () {
      const { dispatched, update } = makeHarness();
      const opened = yield* update(openRoom([growth, cfo]));
      expect(opened.collaboration?.room?.members).toEqual([growth, cfo]);
      expect(opened.roomRecord).toBeUndefined();

      const close: ThreadMetadataMcpUpdateInput = {
        action: "collaborate",
        collaboration: {
          type: "close_room",
          close: {
            summary: "Growth owns outbound.",
            decisions: [{ text: "Growth runs the list" }],
          },
        },
      };
      const closed = yield* update(close);
      expect(closed.roomRecord?.linearIssue).toBe("ENG-123");
      expect(closed.roomRecord?.linearComment).toContain("- Growth runs the list");
      expect(closed.roomRecord?.memoryEntry).toContain("How we set up Growth");

      const again = yield* Effect.flip(update(close));
      expect(again.message).toMatch(/no open room/);
      expect(dispatched).toHaveLength(2);
    }),
  );

  it.effect("keeps a closed room's record when asked to open it again", () =>
    Effect.gen(function* () {
      const { dispatched, update } = makeHarness();
      yield* update(openRoom([growth, cfo]));
      yield* update({
        action: "collaborate",
        collaboration: { type: "close_room", close: { summary: "Done.", decisions: [] } },
      });
      const reopened = yield* Effect.flip(update(openRoom([growth, cfo])));
      expect(reopened.code).toBe("invalid_request");
      expect(reopened.message).toMatch(/room is closed/);
      expect(dispatched).toHaveLength(2);
    }),
  );

  it.effect("opens then closes a room under one clientRequestId", () =>
    Effect.gen(function* () {
      const { dispatched, update } = makeHarness();
      const clientRequestId = "request-reused";
      yield* update({ ...openRoom([growth, cfo]), clientRequestId });
      const closed = yield* update({
        action: "collaborate",
        clientRequestId,
        collaboration: { type: "close_room", close: { summary: "Done.", decisions: [] } },
      });
      expect(closed.collaboration?.room?.closedAt).toBe(NOW);
      expect(closed.roomRecord?.linearIssue).toBe("ENG-123");
      expect(dispatched.map((command) => command.commandId)).toHaveLength(2);
      expect(new Set(dispatched.map((command) => command.commandId)).size).toBe(2);
    }),
  );
});
