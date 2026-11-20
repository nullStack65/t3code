import type { MessageId, ThreadSeenMarker } from "@t3tools/contracts";

export const SEEN_DWELL_MS = 2_000;

export interface SeenSample {
  active: boolean;
  newestVisibleMessageId: MessageId | null;
}

export interface SeenDwellTracker {
  observe(sample: SeenSample): void;
  dispose(): void;
}

export interface SeenTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: SeenTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createSeenDwellTracker(options: {
  onSeen: (messageId: MessageId) => void;
  dwellMs?: number;
  timers?: SeenTimers;
}): SeenDwellTracker {
  const timers = options.timers ?? defaultTimers;
  const dwellMs = options.dwellMs ?? SEEN_DWELL_MS;
  let pendingId: MessageId | null = null;
  let handle: unknown = null;

  const cancel = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
    pendingId = null;
  };

  return {
    observe(sample) {
      const candidate = sample.active ? sample.newestVisibleMessageId : null;
      if (candidate === pendingId) return;
      cancel();
      if (candidate === null) return;
      pendingId = candidate;
      handle = timers.set(() => {
        handle = null;
        pendingId = null;
        options.onSeen(candidate);
      }, dwellMs);
    },
    dispose: cancel,
  };
}

export interface SeenMessage {
  id: MessageId;
  role: string;
}

interface SeenEntry {
  messageId: MessageId;
  seenAt: string;
}

const seenByThreadKey = new Map<string, SeenEntry>();

export function recordSeenMessage(input: {
  threadKey: string;
  messageId: MessageId;
  messages: ReadonlyArray<SeenMessage>;
  seenAt: string;
}): boolean {
  const nextIndex = input.messages.findIndex((message) => message.id === input.messageId);
  if (nextIndex < 0) return false;
  const previous = seenByThreadKey.get(input.threadKey);
  if (previous) {
    const previousIndex = input.messages.findIndex((message) => message.id === previous.messageId);
    if (previousIndex >= nextIndex) return false;
  }
  seenByThreadKey.set(input.threadKey, { messageId: input.messageId, seenAt: input.seenAt });
  return true;
}

export function pickNewestMessageId(
  visibleIds: Iterable<MessageId>,
  messages: ReadonlyArray<SeenMessage>,
): MessageId | null {
  const visible = new Set(visibleIds);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (visible.has(message.id)) return message.id;
  }
  return null;
}

export function buildSeenMarker(input: {
  threadKey: string;
  messages: ReadonlyArray<SeenMessage>;
}): ThreadSeenMarker | undefined {
  const seen = seenByThreadKey.get(input.threadKey);
  if (!seen) return undefined;
  const seenIndex = input.messages.findIndex((message) => message.id === seen.messageId);
  if (seenIndex < 0) return undefined;
  const unseenCount = input.messages
    .slice(seenIndex + 1)
    .filter((message) => message.role === "assistant").length;
  if (unseenCount === 0) return undefined;
  return {
    lastSeenMessageId: seen.messageId,
    seenAt: seen.seenAt,
    unseenCount,
  };
}

export function resetSeenMarkersForTest() {
  seenByThreadKey.clear();
}
