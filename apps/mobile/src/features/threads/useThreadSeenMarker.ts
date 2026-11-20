import type { OnViewableItemsChangedInfo } from "@legendapp/list/react-native";
import {
  createSeenMarkerSession,
  type SeenMarkerSession,
  type SeenMessage,
} from "@t3tools/client-runtime/seen-marker";
import type { MessageId } from "@t3tools/contracts";
import { useIsFocused } from "@react-navigation/native";
import { useCallback, useEffect, useEffectEvent, useRef } from "react";
import { AppState } from "react-native";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import type { ThreadFeedRow } from "./pending-thread-feed";

export function seenMessagesFromFeed(feed: ReadonlyArray<ThreadFeedEntry>): SeenMessage[] {
  const messages: SeenMessage[] = [];
  for (const entry of feed) {
    if (entry.type === "message") messages.push(entry.message);
  }
  return messages;
}

export function viewableMessageIds(
  viewableItems: ReadonlyArray<{ isViewable: boolean; item: ThreadFeedRow }>,
): MessageId[] {
  const ids: MessageId[] = [];
  for (const token of viewableItems) {
    if (token.isViewable && token.item.type === "message") ids.push(token.item.message.id);
  }
  return ids;
}

export function useThreadSeenMarker(input: {
  threadKey: string;
  messages: ReadonlyArray<SeenMessage>;
}) {
  const { threadKey, messages } = input;
  const isFocused = useIsFocused();
  const sessionRef = useRef<SeenMarkerSession | null>(null);
  const visibleIdsRef = useRef<ReadonlyArray<MessageId>>([]);
  const getMessages = useEffectEvent(() => messages);
  const isActive = useEffectEvent(() => isFocused && AppState.currentState === "active");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- AppState listener and the dwell timer for this thread
  useEffect(() => {
    visibleIdsRef.current = [];
    const session = createSeenMarkerSession({
      threadKey,
      getMessages,
      seenAt: () => new Date().toISOString(),
      timers: {
        set: (callback, ms) => setTimeout(callback, ms),
        clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
    });
    sessionRef.current = session;
    session.update({ active: isActive(), visibleIds: visibleIdsRef.current });
    const subscription = AppState.addEventListener("change", () =>
      session.update({ active: isActive() }),
    );
    return () => {
      subscription.remove();
      session.dispose();
      sessionRef.current = null;
    };
  }, [threadKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the dwell timer when screen focus or the thread's messages change
  useEffect(() => {
    sessionRef.current?.update({
      active: isFocused && AppState.currentState === "active",
      ...(messages.length === 0 ? { visibleIds: [] } : {}),
    });
  }, [isFocused, messages]);

  return useCallback((info: OnViewableItemsChangedInfo<ThreadFeedRow>) => {
    visibleIdsRef.current = viewableMessageIds(info.viewableItems);
    sessionRef.current?.update({ visibleIds: visibleIdsRef.current });
  }, []);
}
