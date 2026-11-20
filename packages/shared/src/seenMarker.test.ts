import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { formatSeenMarkerForProvider } from "./seenMarker.ts";

const seenAt = "2026-11-20T03:00:00.000Z";
describe("formatSeenMarkerForProvider", () => {
  it("puts the catch-up line ahead of the founder's text", () => {
    const text = formatSeenMarkerForProvider("Ship the fix", {
      lastSeenMessageId: MessageId.make("message-user-1"),
      seenAt,
      unseenCount: 1,
    });
    expect(text).toBe(
      [
        '<seen_marker last_seen_message_id="message-user-1" seen_at="2026-11-20T03:00:00.000Z" unseen_count="1">',
        "The user last saw message message-user-1; 1 message since are unseen. Open the reply with a short catch-up on only those.",
        "</seen_marker>",
        "",
        "Ship the fix",
      ].join("\n"),
    );
  });

  it("leaves text unchanged when a send carries no marker", () => {
    expect(formatSeenMarkerForProvider("Ship the fix", undefined)).toBe("Ship the fix");
  });

  it("keeps a slash command at the first character", () => {
    const marker = {
      lastSeenMessageId: MessageId.make("message-user-1"),
      seenAt,
      unseenCount: 2,
    };
    const command = formatSeenMarkerForProvider("  /review the diff", marker);
    expect(command.trim().startsWith("/review the diff")).toBe(true);
    expect(command.indexOf("<seen_marker")).toBeGreaterThan(command.indexOf("/review"));
    const prose = formatSeenMarkerForProvider("Review the diff", marker);
    expect(prose.startsWith("<seen_marker")).toBe(true);
    expect(prose.endsWith("Review the diff")).toBe(true);
  });
});
