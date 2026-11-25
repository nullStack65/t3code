import { describe, expect, it } from "vite-plus/test";

import {
  partitionBotGroups,
  resolveBotPresence,
  sortBotThreads,
  splitStandingThreads,
} from "./botPresence";

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

  it("holds a calm waiting state for waiting and usage-limited bots", () => {
    expect(resolveBotPresence({ label: "Waiting" }, "Ops")).toEqual({
      avatarState: "waiting",
      line: "Waiting",
      badge: null,
    });
    expect(resolveBotPresence({ label: "Failed", errorClass: "usage_limit" }, "Ops")).toEqual({
      avatarState: "waiting",
      line: "Limited",
      badge: null,
    });
    expect(
      resolveBotPresence({ label: "Failed", errorClass: "provider_error" }, "Ops").avatarState,
    ).toBe("failed");
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

describe("splitStandingThreads", () => {
  it("sends bots to their own group whatever their pin, settle or snooze state", () => {
    const persona = { name: "Ops" };
    const threads = [
      { id: "a", standing: null, pinnedAt: "2026-11-19T00:00:00Z" },
      { id: "b", standing: persona, pinnedAt: "2026-11-19T00:00:00Z" },
      { id: "c", standing: persona, settledOverride: "settled" },
      { id: "d", standing: persona, snoozedAt: "2026-11-19T00:00:00Z" },
      { id: "e", standing: null },
    ];
    const { bots, rest } = splitStandingThreads(threads);
    expect(bots.map((thread) => thread.id)).toEqual(["b", "c", "d"]);
    expect(rest.map((thread) => thread.id)).toEqual(["a", "e"]);
  });
});

describe("partitionBotGroups", () => {
  const thread = (id: string, audience?: string) => ({
    id,
    source: { inbox: audience === undefined ? null : { audience } },
  });
  const owned = (id: string, owner: "kameron" | "jeff", audience: string | undefined) => ({
    id,
    source: { inbox: { owner, audience } },
  });
  it("puts shared-inbox bots in their own group and leaves the rest as mine", () => {
    expect(
      partitionBotGroups([thread("shared", "shared"), thread("jeff", "jeff"), thread("open")]),
    ).toEqual({
      shared: [thread("shared", "shared")],
      mine: [thread("jeff", "jeff"), thread("open")],
    });
  });

  it("keeps Jeff's personal bots in Kameron's lists beside his own and shared ones", () => {
    const threads = [
      thread("shared", "shared"),
      thread("mine", "kameron"),
      thread("other", "jeff"),
      thread("agents", "agent-only"),
      thread("open"),
    ];
    expect(partitionBotGroups(threads, "kameron")).toEqual({
      mine: [thread("mine", "kameron")],
      shared: [
        thread("shared", "shared"),
        thread("other", "jeff"),
        thread("agents", "agent-only"),
        thread("open"),
      ],
    });
  });

  it("never lists Kameron's personal bots for Jeff", () => {
    const threads = [
      thread("shared", "shared"),
      thread("cos", "kameron"),
      thread("cos-jeff", "jeff"),
      thread("agents", "agent-only"),
      thread("open"),
      owned("kameron-agents", "kameron", "agent-only"),
      owned("kameron-unfiled", "kameron", undefined),
      owned("kameron-shared", "kameron", "shared"),
      owned("kameron-jeff", "kameron", "jeff"),
    ];
    expect(partitionBotGroups(threads, "jeff")).toEqual({
      mine: [thread("cos-jeff", "jeff"), owned("kameron-jeff", "kameron", "jeff")],
      shared: [
        thread("shared", "shared"),
        thread("agents", "agent-only"),
        thread("open"),
        owned("kameron-shared", "kameron", "shared"),
      ],
    });
  });
});
