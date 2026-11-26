import {
  resolveUnseenDivider,
  type SeenMessage,
  type UnseenDivider,
} from "@t3tools/client-runtime/seen-marker";
import type { Founder, MessageId } from "@t3tools/contracts";
import { useMemo, useRef, useState } from "react";

const NO_MESSAGES: ReadonlyArray<SeenMessage> = [];

/**
 * Where "new since you last looked" starts, fixed at the place this founder had been shown when the
 * thread opened. Scrolling moves the stored place for next time, not this visit's line.
 */
export function useUnseenDivider(input: {
  readonly threadKey: string | null;
  readonly viewer: Founder | null;
  readonly shellReady: boolean;
  readonly lastSeenMessageId: MessageId | null;
  readonly messages: ReadonlyArray<SeenMessage> | undefined;
}): UnseenDivider | null {
  const key =
    input.threadKey !== null && input.viewer !== null ? `${input.viewer}:${input.threadKey}` : null;
  const [place, setPlace] = useState<{
    readonly key: string;
    readonly messageId: MessageId | null;
  } | null>(null);
  if (key !== null && input.shellReady && place?.key !== key) {
    setPlace({ key, messageId: input.lastSeenMessageId });
  }
  const anchorId = place?.key === key ? place.messageId : null;
  const messages = input.messages ?? NO_MESSAGES;
  const previousRef = useRef<UnseenDivider | null>(null);

  return useMemo(() => {
    if (anchorId === null) {
      previousRef.current = null;
      return null;
    }
    const next = resolveUnseenDivider({
      messages,
      lastSeenMessageId: anchorId,
    });
    const prev = previousRef.current;
    if (
      prev !== null &&
      next !== null &&
      prev.afterMessageId === next.afterMessageId &&
      prev.count === next.count
    ) {
      return prev;
    }
    previousRef.current = next;
    return next;
  }, [anchorId, messages]);
}
