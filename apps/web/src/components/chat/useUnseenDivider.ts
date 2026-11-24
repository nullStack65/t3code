import {
  resolveUnseenDivider,
  type SeenMessage,
  type UnseenDivider,
} from "@t3tools/client-runtime/seen-marker";
import type { Founder, MessageId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useState } from "react";

type UnseenSourceMessage = SeenMessage & { readonly createdAt: DateTime.Utc };
const NO_MESSAGES: ReadonlyArray<UnseenSourceMessage> = [];

/**
 * Where "new since you last looked" starts, fixed at the place this founder had been shown when the
 * thread opened. Scrolling moves the stored place for next time, not this visit's line.
 */
export function useUnseenDivider(input: {
  readonly threadKey: string | null;
  readonly viewer: Founder | null;
  readonly shellReady: boolean;
  readonly lastSeenMessageId: MessageId | null;
  readonly messages: ReadonlyArray<UnseenSourceMessage> | undefined;
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
  if (anchorId === null) return null;
  return resolveUnseenDivider({
    messages: (input.messages ?? NO_MESSAGES).map((message) => ({
      id: message.id,
      role: message.role,
      ...(message.streaming === undefined ? {} : { streaming: message.streaming }),
      createdAt: DateTime.formatIso(message.createdAt),
    })),
    lastSeenMessageId: anchorId,
  });
}
