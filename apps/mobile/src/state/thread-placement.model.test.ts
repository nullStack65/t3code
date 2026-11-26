import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { submittedThreadParams } from "../features/threads/thread-route-state";
import { resolvePendingRouteThreadRef } from "./pending-thread-creation";
import {
  awaitsPlacement,
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  QueuedThreadMessageSchema,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { draftRoutesAutomatically, seedsAutomaticPlacement } from "./thread-placement-rule";

// The flat schema is the v1-v4 reader older builds decode each outbox file with.
const decodeAsOlderBuild = Schema.decodeUnknownSync(QueuedThreadMessageSchema);
const laptop = EnvironmentId.make("laptop");
const box = EnvironmentId.make("box");
const fixed: QueuedThreadMessage = {
  environmentId: laptop,
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
  commandId: CommandId.make("command-1"),
  text: "Fix the build",
  attachments: [],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  creation: {
    projectId: ProjectId.make("project-a"),
    workspaceMode: "worktree",
    branch: "main",
    worktreePath: null,
  },
  createdAt: "2026-11-18T16:00:00.000Z",
};
const placed: QueuedThreadMessage = {
  ...fixed,
  placement: {
    originEnvironmentId: laptop,
    originProjectId: ProjectId.make("project-a"),
    candidateEnvironmentIds: [laptop, box],
  },
};

describe("a placed task's stored envelope", () => {
  it("round-trips, unbound and bound, through this reader", () => {
    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(placed))).toEqual(placed);
    const bound: QueuedThreadMessage = {
      ...placed,
      environmentId: box,
      placement: {
        ...placed.placement!,
        bound: { environmentId: box, projectId: ProjectId.make("project-b") },
      },
    };
    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(bound))).toEqual(bound);
    expect(awaitsPlacement(placed)).toBe(true);
    expect(awaitsPlacement(bound)).toBe(false);
    expect(awaitsPlacement(fixed)).toBe(false);
  });

  it("is refused by the flat reader every older build has, never read as fixed work", () => {
    expect(() => decodeAsOlderBuild(encodeQueuedThreadMessage(placed))).toThrow();
  });

  it("writes ordinary records flat at the current version 4 and reads versions 1 to 4", () => {
    expect(encodeQueuedThreadMessage(fixed)).toMatchObject({
      schemaVersion: 4,
      environmentId: "laptop",
    });
    for (const schemaVersion of [1, 2, 3, 4]) {
      expect(decodeQueuedThreadMessage({ ...fixed, schemaVersion })).toEqual(fixed);
    }
  });

  it("only ever holds a new task's creation", () => {
    const { creation: _creation, ...turn } = placed;
    expect(() => encodeQueuedThreadMessage(turn)).toThrow();
    const envelope = encodeQueuedThreadMessage(placed) as { message: Record<string, unknown> };
    const { creation: _stored, ...withoutCreation } = envelope.message;
    expect(() => decodeQueuedThreadMessage({ ...envelope, message: withoutCreation })).toThrow();
  });
});

describe("a new task draft's Auto routing", () => {
  const auto = { environmentSelection: "auto" as const };
  it.each([
    ["Auto with no locality", auto, false, true],
    ["a machine pick", { environmentSelection: "manual" as const }, false, false],
    ["a draft from before the choice", {}, false, false],
    ["a scratch folder", auto, true, false],
    [
      "a chosen local checkout",
      {
        ...auto,
        workspaceSelection: { mode: "local" as const, branch: "main", worktreePath: null },
      },
      false,
      false,
    ],
    [
      "an existing worktree",
      {
        ...auto,
        workspaceSelection: { mode: "worktree" as const, branch: "b", worktreePath: "/w" },
      },
      false,
      false,
    ],
    [
      "a PR checkout",
      {
        ...auto,
        workspaceSelection: {
          mode: "worktree" as const,
          branch: null,
          worktreePath: null,
          pullRequestReference: "https://example.test/pull/1",
        },
      },
      false,
      false,
    ],
    [
      "a new worktree from a chosen base branch",
      {
        ...auto,
        workspaceSelection: { mode: "worktree" as const, branch: "main", worktreePath: null },
      },
      false,
      true,
    ],
  ])("routes %s automatically: %s", (_name, draft, isScratch, expected) => {
    expect(draftRoutesAutomatically({ draft, isScratch })).toBe(expected);
  });

  it("keeps a draft whose context names another thread on its machine", () => {
    expect(
      draftRoutesAutomatically({
        draft: {
          ...auto,
          context: { version: 1, records: [{ kind: "thread" } as never] },
        },
        isScratch: false,
      }),
    ).toBe(false);
  });

  it("starts a genuinely new draft as Auto only when more than one machine could take it", () => {
    expect(seedsAutomaticPlacement({ isScratch: false, candidateCount: 2 })).toBe(true);
    expect(seedsAutomaticPlacement({ isScratch: false, candidateCount: 1 })).toBe(false);
    expect(seedsAutomaticPlacement({ isScratch: true, candidateCount: 3 })).toBe(false);
  });
});

describe("a submitted placed task's route", () => {
  const queuedAt = (message: QueuedThreadMessage) => ({
    [`${message.environmentId}:${message.threadId}`]: [message],
  });
  const routeRef = { environmentId: "laptop", threadId: "thread-1" };

  it("carries its message id", () => {
    expect(submittedThreadParams(placed)).toEqual({
      draft: undefined,
      environmentId: "laptop",
      threadId: "thread-1",
      pendingMessageId: "message-1",
    });
    // A fixed task's route is unchanged: environment and thread only.
    expect(submittedThreadParams(fixed)).toEqual({
      draft: undefined,
      environmentId: "laptop",
      threadId: "thread-1",
    });
  });

  it("follows the message to the machine its origin bound, before any detail read", () => {
    const bound = { ...placed, environmentId: box };
    expect(
      resolvePendingRouteThreadRef({
        routeRef,
        pendingMessageId: "message-1",
        queuedMessagesByThreadKey: queuedAt(bound),
        outcomes: {},
      }),
    ).toEqual({ environmentId: box, threadId: "thread-1" });
    // Delivered: the outcome, recorded under B, still names B.
    expect(
      resolvePendingRouteThreadRef({
        routeRef,
        pendingMessageId: "message-1",
        queuedMessagesByThreadKey: {},
        outcomes: { "box:thread-1": { kind: "delivered", message: bound } },
      }),
    ).toEqual({ environmentId: box, threadId: "thread-1" });
  });

  it("is not moved by another task's binding or outcome", () => {
    const other = { ...placed, messageId: MessageId.make("message-other"), environmentId: box };
    expect(
      resolvePendingRouteThreadRef({
        routeRef,
        pendingMessageId: "message-1",
        queuedMessagesByThreadKey: queuedAt(other),
        outcomes: { "box:thread-1": { kind: "delivered", message: other } },
      }),
    ).toBe(routeRef);
    expect(
      resolvePendingRouteThreadRef({
        routeRef,
        pendingMessageId: null,
        queuedMessagesByThreadKey: queuedAt({ ...placed, environmentId: box }),
        outcomes: {},
      }),
    ).toBe(routeRef);
  });
});
