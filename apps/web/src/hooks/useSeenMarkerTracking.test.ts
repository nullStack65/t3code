import { MessageId } from "@t3tools/contracts";
import {
  buildSeenMarker,
  resetSeenMarkersForTest,
  type SeenTimers,
} from "@t3tools/client-runtime/seen-marker";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  startSeenMarkerSampling,
  visibleMessageIds,
  type SeenScrollNode,
} from "./useSeenMarkerTracking";

const seenAt = "2026-11-20T03:00:00.000Z";
const userId = MessageId.make("message-user");
const assistantId = MessageId.make("message-assistant");
const messages = [
  { id: userId, role: "user" },
  { id: assistantId, role: "assistant" },
];

function manualTimers() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  const timers: SeenTimers = {
    set(callback) {
      const id = nextId;
      nextId += 1;
      pending.set(id, callback);
      return id;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    pendingCount: () => pending.size,
    fireNext() {
      const next = pending.entries().next().value;
      if (!next) throw new Error("no dwell timer");
      pending.delete(next[0]);
      next[1]();
    },
  };
}

function scrollNode(): SeenScrollNode {
  return {
    getBoundingClientRect: () => ({ top: 0, bottom: 400 }),
    querySelectorAll: () => [
      {
        getBoundingClientRect: () => ({ top: 10, bottom: 80 }),
        getAttribute: (name: string) => (name === "data-message-id" ? userId : null),
      },
      {
        getBoundingClientRect: () => ({ top: 90, bottom: 200 }),
        getAttribute: (name: string) => (name === "data-message-id" ? assistantId : null),
      },
      {
        getBoundingClientRect: () => ({ top: 500, bottom: 600 }),
        getAttribute: () => MessageId.make("message-below"),
      },
    ],
  };
}

function host() {
  const state = { visibility: "visible" as DocumentVisibilityState, focused: true };
  const listeners = new Map<string, Array<() => void>>();
  const frames: Array<() => void> = [];
  const add = (key: string, listener: EventListenerOrEventListenerObject) => {
    const list = listeners.get(key) ?? [];
    list.push(listener as () => void);
    listeners.set(key, list);
  };
  const remove = (key: string, listener: EventListenerOrEventListenerObject) => {
    listeners.set(
      key,
      (listeners.get(key) ?? []).filter((entry) => entry !== listener),
    );
  };
  return {
    state,
    frames,
    emit(key: string) {
      for (const listener of listeners.get(key) ?? []) listener();
    },
    flush() {
      const queued = frames.splice(0);
      for (const frame of queued) frame();
    },
    samplingHost: {
      window: {
        addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
          add(`win:${type}`, listener),
        removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
          remove(`win:${type}`, listener),
        requestAnimationFrame: (callback: () => void) => {
          frames.push(callback);
          return frames.length;
        },
        cancelAnimationFrame: () => {},
      },
      document: {
        addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
          add(`doc:${type}`, listener),
        removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
          remove(`doc:${type}`, listener),
        hasFocus: () => state.focused,
        get visibilityState() {
          return state.visibility;
        },
      },
    },
  };
}

beforeEach(() => {
  resetSeenMarkersForTest();
});

describe("timeline seen sampling", () => {
  it("scroll and a 2 second dwell update local state only", () => {
    const fetchSpy = vi.fn();
    const socketSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("WebSocket", socketSpy);
    const clock = manualTimers();
    const page = host();
    const sampling = startSeenMarkerSampling({
      host: page.samplingHost,
      threadKey: "env:thread",
      getScrollNode: scrollNode,
      getMessages: () => messages,
      now: () => new Date(seenAt),
      timers: clock.timers,
    });
    page.flush();
    expect(buildSeenMarker("env:thread")).toBeUndefined();
    page.emit("doc:scroll");
    page.flush();
    expect(clock.pendingCount()).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(socketSpy).not.toHaveBeenCalled();
    clock.fireNext();
    expect(buildSeenMarker("env:thread")).toEqual({
      lastSeenMessageId: assistantId,
      seenAt,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(socketSpy).not.toHaveBeenCalled();
    expect(Object.keys(sampling).sort()).toEqual(["dispose", "requestSample"]);
    sampling.dispose();
    vi.unstubAllGlobals();
  });

  it("marks the newest settled message once the list rests at the bottom", () => {
    const clock = manualTimers();
    const page = host();
    const latestId = MessageId.make("message-latest");
    const sampling = startSeenMarkerSampling({
      host: page.samplingHost,
      threadKey: "env:thread",
      getScrollNode: () => ({
        ...scrollNode(),
        scrollTop: 600,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
      getMessages: () => [...messages, { id: latestId, role: "assistant" }],
      now: () => new Date(seenAt),
      timers: clock.timers,
    });
    page.flush();
    clock.fireNext();
    expect(buildSeenMarker("env:thread")).toEqual({ lastSeenMessageId: latestId, seenAt });
    sampling.dispose();
  });

  it("does not mark a hidden or blurred window", () => {
    const clock = manualTimers();
    const page = host();
    page.state.visibility = "hidden";
    page.state.focused = false;
    const sampling = startSeenMarkerSampling({
      host: page.samplingHost,
      threadKey: "env:thread",
      getScrollNode: scrollNode,
      getMessages: () => messages,
      now: () => new Date(seenAt),
      timers: clock.timers,
    });
    page.flush();
    page.emit("doc:scroll");
    page.flush();
    expect(clock.pendingCount()).toBe(0);
    expect(buildSeenMarker("env:thread")).toBeUndefined();
    sampling.dispose();
  });

  it("cancels a dwell when the window blurs", () => {
    const clock = manualTimers();
    const page = host();
    const sampling = startSeenMarkerSampling({
      host: page.samplingHost,
      threadKey: "env:thread",
      getScrollNode: scrollNode,
      getMessages: () => messages,
      now: () => new Date(seenAt),
      timers: clock.timers,
    });
    page.flush();
    expect(clock.pendingCount()).toBe(1);
    page.state.focused = false;
    page.emit("win:blur");
    expect(page.frames).toEqual([]);
    expect(clock.pendingCount()).toBe(0);
    expect(buildSeenMarker("env:thread")).toBeUndefined();
    page.state.focused = true;
    page.emit("win:focus");
    expect(page.frames).toEqual([]);
    expect(clock.pendingCount()).toBe(1);
    page.state.visibility = "hidden";
    page.emit("doc:visibilitychange");
    expect(page.frames).toEqual([]);
    expect(clock.pendingCount()).toBe(0);
    sampling.dispose();
  });

  it("ignores rows outside the viewport", () => {
    expect(visibleMessageIds(scrollNode())).toEqual([userId, assistantId]);
  });
});
