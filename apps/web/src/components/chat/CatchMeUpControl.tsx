import {
  CATCH_ME_UP_TEXT,
  catchUpOffer,
  type SeenMessage,
} from "@t3tools/client-runtime/seen-marker";
import type { Founder, MessageId, ThreadSeenMarker } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";

interface CatchUpSnapshot {
  readonly key: string;
  readonly messageId: MessageId | null;
  readonly seenAt: string | null;
}

/**
 * One catch-up offer per open of a thread, taken from the place this founder had already been
 * shown. Scrolling updates that place for next time and does not start a turn. The button does.
 */
export function CatchMeUpControl(props: {
  readonly threadKey: string | null;
  readonly viewer: Founder | null;
  readonly shellReady: boolean;
  readonly lastSeenMessageId: MessageId | null;
  readonly seenAt: string | null;
  readonly messages: ReadonlyArray<SeenMessage>;
  readonly canSend: boolean;
  readonly onCatchUp: (marker: ThreadSeenMarker) => Promise<boolean>;
}) {
  const key =
    props.threadKey !== null && props.viewer !== null ? `${props.viewer}:${props.threadKey}` : null;
  const [snapshot, setSnapshot] = useState<CatchUpSnapshot | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- capture this founder's place once per open, before this visit advances it
  useEffect(() => {
    if (key === null || !props.shellReady) return;
    setSnapshot((current) =>
      current?.key === key
        ? current
        : { key, messageId: props.lastSeenMessageId, seenAt: props.seenAt },
    );
  }, [key, props.shellReady, props.lastSeenMessageId, props.seenAt]);

  const offer =
    key === null || dismissedKey === key
      ? null
      : catchUpOffer({
          messages: props.messages,
          lastSeenMessageId: snapshot?.key === key ? snapshot.messageId : null,
          seenAt: snapshot?.key === key ? snapshot.seenAt : null,
        });
  if (offer === null || !props.canSend) return null;

  return (
    <div className="mb-2 flex justify-center">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={sending}
        data-testid="catch-me-up"
        onClick={() => {
          if (sending) return;
          setSending(true);
          void props
            .onCatchUp(offer)
            .then((started) => {
              if (started && key !== null) setDismissedKey(key);
            })
            .finally(() => setSending(false));
        }}
      >
        {CATCH_ME_UP_TEXT}
      </Button>
    </div>
  );
}
