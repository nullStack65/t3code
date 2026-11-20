import type { ThreadSeenMarkerSummary } from "@t3tools/contracts";

export function formatSeenMarkerForProvider(
  text: string,
  marker: ThreadSeenMarkerSummary | undefined,
) {
  if (marker === undefined || marker.unseenCount === 0) return text;
  const noun = marker.unseenCount === 1 ? "message" : "messages";
  return [
    `<seen_marker last_seen_message_id="${marker.lastSeenMessageId}" seen_at="${marker.seenAt}" unseen_count="${marker.unseenCount}">`,
    `The user last saw message ${marker.lastSeenMessageId}; ${marker.unseenCount} ${noun} since are unseen. Open the reply with a short catch-up on only those.`,
    "</seen_marker>",
    "",
    text,
  ].join("\n");
}
