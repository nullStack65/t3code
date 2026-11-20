import { MessageId } from "@t3tools/contracts";
import { buildSeenMarker, resetSeenMarkersForTest } from "@t3tools/client-runtime/seen-marker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const reactState = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>,
  cursor: 0,
  cleanups: [] as Array<() => void>,
  focused: true,
  appState: "active",
  appListener: null as null | ((state: string) => void),
}));

vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const index = reactState.cursor;
    reactState.cursor += 1;
    const existing = reactState.refs[index];
    if (existing) return existing;
    const ref = { current: initial };
    reactState.refs[index] = ref;
    return ref;
  },
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (typeof cleanup === "function") reactState.cleanups.push(cleanup);
  },
  useEffectEvent: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
}));

vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => reactState.focused,
}));

vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return reactState.appState;
    },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      reactState.appListener = listener;
      return {
        remove: () => {
          reactState.appListener = null;
        },
      };
    },
  },
}));

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { seenMessagesFromFeed, useThreadSeenMarker, viewableMessageIds } from "./useThreadSeenMarker";

const userId = MessageId.make("message-user");
const assistantId = MessageId.make("message-assistant");
const messages = [
  { id: userId, role: "user" },
  { id: assistantId, role: "assistant" },
];

function feedMessage(id: MessageId, role: "user" | "assistant"): ThreadFeedEntry {
  return {
    type: "message",
    id,
    createdAt: "2026-11-20T03:00:00.000Z",
    message: {
      id,
      role,
      text: id,
      turnId: null,
      streaming: false,
      createdAt: "2026-11-20T03:00:00.000Z",
      updatedAt: "2026-11-20T03:00:00.000Z",
    },
  } as ThreadFeedEntry;
}

function renderTracker() {
  reactState.cursor = 0;
  reactState.cleanups = [];
  return useThreadSeenMarker({ threadKey: "env:thread", messages });
}

function showAssistant(onViewable: ReturnType<typeof useThreadSeenMarker>) {
  onViewable({
    viewableItems: [
      { isViewable: true, item: feedMessage(userId, "user"), index: 0, key: userId },
      { isViewable: true, item: feedMessage(assistantId, "assistant"), index: 1, key: assistantId },
    ],
  } as unknown as Parameters<typeof onViewable>[0]);
}

beforeEach(() => {
  reactState.refs = [];
  reactState.cursor = 0;
  reactState.cleanups = [];
  reactState.focused = true;
  reactState.appState = "active";
  reactState.appListener = null;
  resetSeenMarkersForTest();
  vi.useFakeTimers();
});

afterEach(() => {
  for (const cleanup of reactState.cleanups) cleanup();
  vi.useRealTimers();
});

describe("mobile seen marker", () => {
  it("marks a focused active screen after 2 seconds and not sooner", () => {
    const onViewable = renderTracker();
    showAssistant(onViewable);
    vi.advanceTimersByTime(1_999);
    expect(buildSeenMarker("env:thread")).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(buildSeenMarker("env:thread")?.lastSeenMessageId).toBe(assistantId);
  });

  it("does not count an unfocused screen or a background app", () => {
    reactState.focused = false;
    const blurred = renderTracker();
    showAssistant(blurred);
    vi.advanceTimersByTime(2_000);
    expect(buildSeenMarker("env:thread")).toBeUndefined();

    reactState.refs = [];
    reactState.focused = true;
    reactState.appState = "background";
    const backgrounded = renderTracker();
    showAssistant(backgrounded);
    vi.advanceTimersByTime(2_000);
    expect(buildSeenMarker("env:thread")).toBeUndefined();
  });

  it("cancels a dwell when the app leaves the foreground", () => {
    const onViewable = renderTracker();
    showAssistant(onViewable);
    vi.advanceTimersByTime(1_000);
    reactState.appState = "background";
    reactState.appListener?.("background");
    vi.advanceTimersByTime(2_000);
    expect(buildSeenMarker("env:thread")).toBeUndefined();
  });

  it("reads message rows and skips everything else", () => {
    const feed = [
      feedMessage(userId, "user"),
      { type: "work-toggle", id: "toggle" } as ThreadFeedEntry,
      feedMessage(assistantId, "assistant"),
    ];
    expect(seenMessagesFromFeed(feed).map((message) => message.id)).toEqual([userId, assistantId]);
    expect(
      viewableMessageIds([
        { isViewable: false, item: feed[0]! },
        { isViewable: true, item: feed[1]! },
        { isViewable: true, item: feed[2]! },
      ]),
    ).toEqual([assistantId]);
  });
});

