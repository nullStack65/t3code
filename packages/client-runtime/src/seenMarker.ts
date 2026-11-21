import type { Founder, MessageId, ThreadSeenMarker } from "@t3tools/contracts";

const SEEN_DWELL_MS = 2_000;

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

function createSeenDwellTracker(options: {
  onSeen: (messageId: MessageId) => void;
  dwellMs?: number;
  timers: SeenTimers;
}): SeenDwellTracker {
  const timers = options.timers;
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
  streaming?: boolean;
}

interface SeenEntry {
  messageId: MessageId;
  seenAt: string;
}

const seenByThreadKey = new Map<string, SeenEntry>();

/** Unassigned viewers keep the bare thread key, so a browser with no founder behaves as before. */
function seenMarkerKey(threadKey: string, founder?: Founder | null) {
  return founder == null ? threadKey : `${founder}:${threadKey}`;
}

function recordSeenMessage(input: {
  threadKey: string;
  founder?: Founder | null;
  messageId: MessageId;
  messages: ReadonlyArray<SeenMessage>;
  seenAt: string;
  /** A place already stored for this founder. A dwell behind it does not rewind the marker. */
  notBeforeMessageId?: MessageId | null;
}): boolean {
  const key = seenMarkerKey(input.threadKey, input.founder);
  const nextIndex = input.messages.findIndex((message) => message.id === input.messageId);
  if (nextIndex < 0 || input.messages[nextIndex]?.streaming === true) return false;
  if (input.notBeforeMessageId != null) {
    const floorIndex = input.messages.findIndex(
      (message) => message.id === input.notBeforeMessageId,
    );
    if (floorIndex >= 0 && nextIndex <= floorIndex) return false;
  }
  const previous = seenByThreadKey.get(key);
  if (previous) {
    const previousIndex = input.messages.findIndex((message) => message.id === previous.messageId);
    if (previousIndex >= nextIndex) return false;
  }
  seenByThreadKey.set(key, { messageId: input.messageId, seenAt: input.seenAt });
  return true;
}

export function pickNewestMessageId(
  visibleIds: Iterable<MessageId>,
  messages: ReadonlyArray<SeenMessage>,
): MessageId | null {
  const visible = new Set(visibleIds);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.streaming === true) continue;
    if (visible.has(message.id)) return message.id;
  }
  return null;
}

/**
 * The catch-up offer for messages after the place this founder had already been shown.
 * Opening a thread does not call this. The Catch me up button is the only caller that
 * starts a turn, and only with the marker it returns.
 */
export function catchUpOffer(input: {
  readonly messages: ReadonlyArray<SeenMessage>;
  readonly lastSeenMessageId: MessageId | null | undefined;
  readonly seenAt: string | null | undefined;
}): ThreadSeenMarker | null {
  if (input.lastSeenMessageId == null || input.seenAt == null || input.seenAt === "") return null;
  const index = input.messages.findIndex((message) => message.id === input.lastSeenMessageId);
  const after = index < 0 ? input.messages : input.messages.slice(index + 1);
  const unseen = after.some(
    (message) => message.role === "assistant" && message.streaming !== true,
  );
  if (!unseen) return null;
  return { lastSeenMessageId: input.lastSeenMessageId, seenAt: input.seenAt };
}

export const CATCH_ME_UP_TEXT = "Catch me up";

export function buildSeenMarker(
  threadKey: string,
  founder?: Founder | null,
): ThreadSeenMarker | undefined {
  const seen = seenByThreadKey.get(seenMarkerKey(threadKey, founder));
  if (!seen) return undefined;
  return { lastSeenMessageId: seen.messageId, seenAt: seen.seenAt };
}

export interface SeenMarkerSession {
  update(input: { active?: boolean; visibleIds?: Iterable<MessageId> }): void;
  dispose(): void;
}

export function createSeenMarkerSession(input: {
  threadKey: string;
  /** Whose place this is. Two founders on one browser keep two positions. */
  founder?: Founder | null;
  getMessages: () => ReadonlyArray<SeenMessage>;
  seenAt: () => string;
  timers: SeenTimers;
  dwellMs?: number;
  /** The stored place. Read on each dwell so a late shell still blocks a rewind. */
  notBefore?: () => MessageId | null | undefined;
  /** Fired when a human's place moves. Callers persist it. They must not start a turn. */
  onRecorded?: (messageId: MessageId, seenAt: string) => void;
}): SeenMarkerSession {
  const tracker = createSeenDwellTracker({
    onSeen: (messageId) => {
      const seenAt = input.seenAt();
      const notBefore = input.notBefore?.() ?? null;
      const recorded = recordSeenMessage({
        threadKey: input.threadKey,
        ...(input.founder !== undefined ? { founder: input.founder } : {}),
        messageId,
        messages: input.getMessages(),
        seenAt,
        ...(notBefore == null ? {} : { notBeforeMessageId: notBefore }),
      });
      if (recorded) input.onRecorded?.(messageId, seenAt);
    },
    timers: input.timers,
    ...(input.dwellMs !== undefined ? { dwellMs: input.dwellMs } : {}),
  });
  let active = false;
  let visibleIds: ReadonlyArray<MessageId> = [];

  return {
    update(next) {
      if (next.active !== undefined) active = next.active;
      if (next.visibleIds !== undefined) visibleIds = [...next.visibleIds];
      tracker.observe({
        active,
        newestVisibleMessageId: active
          ? pickNewestMessageId(visibleIds, input.getMessages())
          : null,
      });
    },
    dispose: tracker.dispose,
  };
}

export function resetSeenMarkersForTest() {
  seenByThreadKey.clear();
}
