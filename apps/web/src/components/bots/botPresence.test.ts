import { describe, expect, it } from "vite-plus/test";

import { resolveBotPresence, sortBotThreads } from "./botPresence";

describe("resolveBotPresence", () => {
  it.each(["Pending Approval", "Awaiting Input", "Guest Request", "Plan Ready"] as const)(
    "rings the avatar and badges the row when %s",
    (label) => {
      expect(resolveBotPresence({ label }, "Ops lane")).toEqual({
        avatarState: "needs-you",
        line: label,
        badge: "needs-you",
      });
    },
  );

  it("blinks while working and shows failure on its own ring", () => {
    expect(resolveBotPresence({ label: "Working" }, null).avatarState).toBe("running");
    expect(resolveBotPresence({ label: "Connecting" }, null).avatarState).toBe("running");
    expect(resolveBotPresence({ label: "Failed" }, "Ops")).toEqual({
      avatarState: "failed",
      line: "Failed",
      badge: null,
    });
  });

  it("falls back to the role line when idle", () => {
    expect(resolveBotPresence(null, "Daily digest")).toEqual({
      avatarState: "idle",
      line: "Daily digest",
      badge: null,
    });
    expect(resolveBotPresence(null, null).line).toBeNull();
    expect(resolveBotPresence({ label: "Completed" }, null)).toEqual({
      avatarState: "idle",
      line: "New reply",
      badge: "unread",
    });
  });
});

describe("sortBotThreads", () => {
  it("orders by persona name, case-insensitively, then id", () => {
    const threads = [
      { id: "c", standing: { name: "zed" } },
      { id: "b", standing: { name: "Alpha" } },
      { id: "a", standing: { name: "alpha" } },
    ];
    expect(sortBotThreads(threads).map((thread) => thread.id)).toEqual(["a", "b", "c"]);
  });
});
