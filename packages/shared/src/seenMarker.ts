import type { Founder, ThreadSeenMarkerSummary } from "@t3tools/contracts";

const FOUNDER_NAMES = { kameron: "Kameron", jeff: "Jeff" } satisfies Record<Founder, string>;

/** `[From: Kameron]` on a shared thread, so the model knows which founder typed it. */
export function formatSharedSenderForProvider(text: string, founder: Founder | null | undefined) {
  if (founder == null) return text;
  if (text.trim().startsWith("/")) return text;
  return `[From: ${FOUNDER_NAMES[founder]}]\n\n${text}`;
}

export function formatSeenMarkerForProvider(
  text: string,
  marker: ThreadSeenMarkerSummary | undefined,
  founder?: Founder | null,
) {
  if (marker === undefined || marker.unseenCount === 0) return text;
  const noun = marker.unseenCount === 1 ? "message" : "messages";
  const who = founder ? FOUNDER_NAMES[founder] : null;
  const catchUp = who
    ? `${who} last saw message ${marker.lastSeenMessageId}; ${marker.unseenCount} ${noun} since are unseen. Open the reply with two lines on only those, while they were away.`
    : `The user last saw message ${marker.lastSeenMessageId}; ${marker.unseenCount} ${noun} since are unseen. Open the reply with a short catch-up on only those.`;
  const block = [
    `<seen_marker last_seen_message_id="${marker.lastSeenMessageId}" seen_at="${marker.seenAt}" unseen_count="${marker.unseenCount}">`,
    catchUp,
    "</seen_marker>",
  ].join("\n");
  if (text.trim().startsWith("/")) return text;
  return `${block}\n\n${text}`;
}
