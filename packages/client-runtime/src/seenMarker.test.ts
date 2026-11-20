import { MessageId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  buildSeenMarker,
  createSeenMarkerSession,
  pickNewestMessageId,
  resetSeenMarkersForTest,
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
});
