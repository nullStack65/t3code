import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { formatSeenMarkerForProvider, formatSharedSenderForProvider } from "./seenMarker.ts";

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

  it("passes a slash command to the provider unchanged", () => {
    const marker = {
      lastSeenMessageId: MessageId.make("message-user-1"),
      seenAt,
      unseenCount: 2,
    };
    for (const command of ["/compact", "  /review the diff", "/goal pause"]) {
      expect(formatSeenMarkerForProvider(command, marker)).toBe(command);
    }
    const prose = formatSeenMarkerForProvider("Review the diff", marker);
    expect(prose.startsWith("<seen_marker")).toBe(true);
    expect(prose.endsWith("Review the diff")).toBe(true);
  });
});

describe("formatSharedSenderForProvider", () => {
  it("names the founder on a shared send and leaves a command alone", () => {
    expect(formatSharedSenderForProvider("Ship the fix", "jeff")).toBe(
      "[From: Jeff]\n\nShip the fix",
    );
    expect(formatSharedSenderForProvider("Ship the fix", "kameron")).toBe(
      "[From: Kameron]\n\nShip the fix",
    );
    expect(formatSharedSenderForProvider("Ship the fix", null)).toBe("Ship the fix");
    expect(formatSharedSenderForProvider("/compact", "jeff")).toBe("/compact");
  });
});

describe("a shared catch-up", () => {
  it("asks for two lines about the founder who was away", () => {
    const text = formatSeenMarkerForProvider(
      "Ship the fix",
      { lastSeenMessageId: MessageId.make("message-user-1"), seenAt, unseenCount: 2 },
      "jeff",
    );
    expect(text).toContain(
      "Jeff last saw message message-user-1; 2 messages since are unseen. Open the reply with two lines on only those, while they were away.",
    );
    expect(text.endsWith("Ship the fix")).toBe(true);
  });
});
