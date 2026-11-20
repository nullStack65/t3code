import type { MessageId, ThreadSeenMarker, ThreadSeenMarkerSummary } from "@t3tools/contracts";

export function summarizeSeenMarker(
  marker: ThreadSeenMarker | undefined,
  messages: ReadonlyArray<{ id: MessageId; role: string }>,
): ThreadSeenMarkerSummary | undefined {
  if (marker === undefined) return undefined;
  const seenIndex = messages.findIndex((message) => message.id === marker.lastSeenMessageId);
  if (seenIndex < 0) return undefined;
  let unseenCount = 0;
  for (let index = seenIndex + 1; index < messages.length; index += 1) {
    if (messages[index]!.role === "assistant") unseenCount += 1;
  }
  if (unseenCount === 0) return undefined;
  return {
    lastSeenMessageId: marker.lastSeenMessageId,
    seenAt: marker.seenAt,
    unseenCount,
  };
}

export function formatSeenMarkerForProvider(
  text: string,
  marker: ThreadSeenMarkerSummary | undefined,
) {
  if (marker === undefined || marker.unseenCount === 0) return text;
  const noun = marker.unseenCount === 1 ? "message" : "messages";
  const block = [
    `<seen_marker last_seen_message_id="${marker.lastSeenMessageId}" seen_at="${marker.seenAt}" unseen_count="${marker.unseenCount}">`,
    `The user last saw message ${marker.lastSeenMessageId}; ${marker.unseenCount} ${noun} since are unseen. Open the reply with a short catch-up on only those.`,
    "</seen_marker>",
  ].join("\n");
  if (text.trim().startsWith("/")) return `${text}\n\n${block}`;
  return `${block}\n\n${text}`;
}
