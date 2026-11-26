import { MessageId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  buildSeenMarker,
  catchUpOffer,
  createSeenMarkerSession,
  pickNewestMessageId,
  resetSeenMarkersForTest,
  resolveUnseenDivider,
  type SeenTimers,
} from "./seenMarker.ts";

const seenAt = "2026-11-20T03:00:00.000Z";
const userId = MessageId.make("message-user");
const assistantId = MessageId.make("message-assistant");
const laterId = MessageId.make("message-later");
const messages = [
  { id: userId, role: "user" },
  { id: assistantId, role: "assistant" },
  { id: laterId, role: "assistant" },
];

function manualTimers() {
  let nextId = 1;
  const pending = new Map<number, { callback: () => void; ms: number }>();
  const timers: SeenTimers = {
    set(callback, ms) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { callback, ms });
      return id;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    pendingMs: () => [...pending.values()].map((entry) => entry.ms),
    fireNext() {
      const next = pending.entries().next().value;
      if (!next) throw new Error("no dwell timer");
      pending.delete(next[0]);
      next[1].callback();
    },
  };
}

function session(clock: ReturnType<typeof manualTimers>) {
  return createSeenMarkerSession({
    threadKey: "env:thread",
    getMessages: () => messages,
    seenAt: () => seenAt,
    timers: clock.timers,
  });
}

beforeEach(() => {
  resetSeenMarkersForTest();
});

describe("seen dwell", () => {
  it("marks the newest visible message after 2 seconds and not before", () => {
    const clock = manualTimers();
    const tracker = session(clock);
    tracker.update({ active: true, visibleIds: [userId, assistantId] });
    expect(clock.pendingMs()).toEqual([2_000]);
    expect(buildSeenMarker("env:thread")).toBeUndefined();
    clock.fireNext();
    expect(buildSeenMarker("env:thread")).toEqual({
      lastSeenMessageId: assistantId,
      seenAt,
    });
    tracker.dispose();
  });

  it("does not count a hidden or unfocused window", () => {
    const clock = manualTimers();
    const tracker = session(clock);
    tracker.update({ active: false, visibleIds: [assistantId] });
    expect(clock.pendingMs()).toEqual([]);
    expect(buildSeenMarker("env:thread")).toBeUndefined();

    tracker.update({ active: true, visibleIds: [assistantId] });
    expect(clock.pendingMs()).toEqual([2_000]);
    tracker.update({ active: false, visibleIds: [assistantId] });
    expect(clock.pendingMs()).toEqual([]);
    expect(buildSeenMarker("env:thread")).toBeUndefined();
    tracker.dispose();
  });

  it("only moves forward", () => {
    const clock = manualTimers();
    const tracker = session(clock);
    tracker.update({ active: true, visibleIds: [laterId] });
    clock.fireNext();
    tracker.update({ active: true, visibleIds: [assistantId] });
    clock.fireNext();
    expect(buildSeenMarker("env:thread")?.lastSeenMessageId).toBe(laterId);
    tracker.dispose();
  });

  it("does not record a view when messages are only read", () => {
    expect(pickNewestMessageId([userId, assistantId], messages)).toBe(assistantId);
    expect(buildSeenMarker("env:thread")).toBeUndefined();
  });

  it("does not mark a message that is still streaming", () => {
    const streamingId = MessageId.make("message-streaming");
    const withStreaming = [...messages, { id: streamingId, role: "assistant", streaming: true }];
    expect(pickNewestMessageId([assistantId, streamingId], withStreaming)).toBe(assistantId);
    expect(pickNewestMessageId([streamingId], withStreaming)).toBeNull();

    const clock = manualTimers();
    const tracker = createSeenMarkerSession({
      threadKey: "env:thread",
      getMessages: () => withStreaming,
      seenAt: () => seenAt,
      timers: clock.timers,
    });
    tracker.update({ active: true, visibleIds: [streamingId] });
    expect(clock.pendingMs()).toEqual([]);
    tracker.update({ active: true, visibleIds: [assistantId, streamingId] });
    clock.fireNext();
    expect(buildSeenMarker("env:thread")?.lastSeenMessageId).toBe(assistantId);
    tracker.dispose();
  });
});

describe("stored place", () => {
  it("does not record a message at or before the stored one", () => {
    const afterId = MessageId.make("message-after");
    const recorded: Array<MessageId> = [];
    const clock = manualTimers();
    const tracker = createSeenMarkerSession({
      threadKey: "env:thread",
      getMessages: () => [...messages, { id: afterId, role: "assistant" }],
      seenAt: () => seenAt,
      timers: clock.timers,
      notBefore: () => laterId,
      onRecorded: (messageId) => {
        recorded.push(messageId);
      },
    });
    tracker.update({ active: true, visibleIds: [assistantId] });
    clock.fireNext();
    expect(recorded).toEqual([]);
    expect(buildSeenMarker("env:thread")).toBeUndefined();
    tracker.update({ active: true, visibleIds: [afterId] });
    clock.fireNext();
    expect(recorded).toEqual([afterId]);
    expect(buildSeenMarker("env:thread")?.lastSeenMessageId).toBe(afterId);
    tracker.dispose();
  });
});

describe("catch-up offer", () => {
  it("offers a marker only when a finished assistant message is still unseen", () => {
    expect(
      catchUpOffer({
        messages,
        lastSeenMessageId: assistantId,
        seenAt,
      }),
    ).toEqual({ lastSeenMessageId: assistantId, seenAt });
    expect(
      catchUpOffer({
        messages,
        lastSeenMessageId: laterId,
        seenAt,
      }),
    ).toBeNull();
    expect(
      catchUpOffer({
        messages: [
          ...messages,
          { id: MessageId.make("streaming"), role: "assistant", streaming: true },
        ],
        lastSeenMessageId: laterId,
        seenAt,
      }),
    ).toBeNull();
    expect(catchUpOffer({ messages, lastSeenMessageId: null, seenAt })).toBeNull();
    expect(catchUpOffer({ messages, lastSeenMessageId: assistantId, seenAt: null })).toBeNull();
    expect(
      catchUpOffer({
        messages,
        lastSeenMessageId: MessageId.make("missing"),
        seenAt,
      }),
    ).toEqual({ lastSeenMessageId: MessageId.make("missing"), seenAt });
  });
});

describe("unseen divider", () => {
  const thread = [
    { id: MessageId.make("m1"), role: "user" },
    { id: MessageId.make("m2"), role: "assistant" },
    { id: MessageId.make("m3"), role: "user" },
    { id: MessageId.make("m4"), role: "assistant" },
    { id: MessageId.make("m5"), role: "assistant", streaming: true },
  ];

  it("counts settled replies after the stored place and anchors on its id", () => {
    expect(
      resolveUnseenDivider({ messages: thread, lastSeenMessageId: MessageId.make("m2") }),
    ).toEqual({ afterMessageId: MessageId.make("m2"), count: 1 });
  });

  it("draws nothing when nothing is new or the place is unknown", () => {
    expect(
      resolveUnseenDivider({ messages: thread, lastSeenMessageId: MessageId.make("m4") }),
    ).toBeNull();
    expect(
      resolveUnseenDivider({ messages: thread, lastSeenMessageId: MessageId.make("gone") }),
    ).toBeNull();
    expect(resolveUnseenDivider({ messages: thread, lastSeenMessageId: null })).toBeNull();
  });
});

describe("per founder", () => {
  it("keeps a separate place for each founder of one thread", () => {
    const clock = manualTimers();
    const jeff = createSeenMarkerSession({
      threadKey: "env:thread",
      founder: "jeff",
      getMessages: () => messages,
      seenAt: () => seenAt,
      timers: clock.timers,
    });
    jeff.update({ active: true, visibleIds: [assistantId] });
    clock.fireNext();
    expect(buildSeenMarker("env:thread", "jeff")?.lastSeenMessageId).toBe(assistantId);
    expect(buildSeenMarker("env:thread", "kameron")).toBeUndefined();
    expect(buildSeenMarker("env:thread")).toBeUndefined();

    const kameron = createSeenMarkerSession({
      threadKey: "env:thread",
      founder: "kameron",
      getMessages: () => messages,
      seenAt: () => seenAt,
      timers: clock.timers,
    });
    kameron.update({ active: true, visibleIds: [userId] });
    clock.fireNext();
    expect(buildSeenMarker("env:thread", "kameron")?.lastSeenMessageId).toBe(userId);
    expect(buildSeenMarker("env:thread", "jeff")?.lastSeenMessageId).toBe(assistantId);
    jeff.dispose();
    kameron.dispose();
  });
});

describe("agent messages stamped for the user's timeline", () => {
  const stamped = MessageId.make("message-agent-sent");
  const plain = MessageId.make("message-agent-plain");
  const conversation = [
    { id: userId, role: "user" },
    { id: plain, role: "user" },
    { id: stamped, role: "user", timelineVisibility: "user_timeline" as const },
  ];

  it("counts a stamped agent-sent message as new, and an unstamped one as before", () => {
    expect(resolveUnseenDivider({ messages: conversation, lastSeenMessageId: userId })).toEqual({
      afterMessageId: userId,
      count: 1,
    });
    expect(catchUpOffer({ messages: conversation, lastSeenMessageId: userId, seenAt })).toEqual({
      lastSeenMessageId: userId,
      seenAt,
    });
    expect(
      catchUpOffer({ messages: conversation.slice(0, 2), lastSeenMessageId: userId, seenAt }),
    ).toBeNull();
  });

  it("keeps counting every finished assistant message, folded or not", () => {
    const withReplies = [
      ...conversation.slice(0, 1),
      { id: assistantId, role: "assistant", timelineVisibility: "agent_fold" as const },
      { id: laterId, role: "assistant" },
      { id: MessageId.make("message-streaming"), role: "assistant", streaming: true },
    ];
    expect(resolveUnseenDivider({ messages: withReplies, lastSeenMessageId: userId })).toEqual({
      afterMessageId: userId,
      count: 2,
    });
  });

  it("never counts a human user's own message as unseen even if stamped user_timeline", () => {
    const founderStamped = MessageId.make("message-founder-stamped");
    const agentStamped = MessageId.make("message-agent-stamped");
    const thread = [
      { id: userId, role: "user", createdBy: "user" },
      {
        id: founderStamped,
        role: "user",
        createdBy: "user",
        timelineVisibility: "user_timeline" as const,
      },
      {
        id: agentStamped,
        role: "user",
        createdBy: "agent",
        timelineVisibility: "user_timeline" as const,
      },
    ];
    expect(resolveUnseenDivider({ messages: thread, lastSeenMessageId: userId })).toEqual({
      afterMessageId: userId,
      count: 1,
    });
    expect(
      catchUpOffer({ messages: thread.slice(0, 2), lastSeenMessageId: userId, seenAt }),
    ).toBeNull();
  });
});
