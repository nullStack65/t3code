import { describe, expect, it } from "vite-plus/test";

import {
  botPresenceInput,
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
      line: "Blocked · quota",
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

describe("botPresenceInput", () => {
  it("keeps a quota block on the bot after its failure is seen", () => {
    const blocked = { status: "failed", lastErrorClass: "usage_limit" } as const;
    expect(resolveBotPresence(botPresenceInput(null, blocked), "Ops").line).toBe("Blocked · quota");
    expect(
      botPresenceInput(null, { status: "failed", lastErrorClass: "provider_error" }),
    ).toBeNull();
    expect(botPresenceInput({ label: "Working" }, blocked)?.label).toBe("Working");
  });
});

describe("partitionBotGroups", () => {
  const thread = (id: string, audience?: string, name = "Ops", machine?: "kameron" | "jeff") => ({
    id,
    machine,
    standing: { name },
    source: { inbox: audience === undefined ? null : { audience } },
  });

  it("puts shared-inbox bots in their own group and leaves the rest as mine", () => {
    expect(
      partitionBotGroups([thread("shared", "shared"), thread("jeff", "jeff"), thread("open")]),
    ).toEqual({
      closura: [thread("shared", "shared")],
      mine: [thread("jeff", "jeff"), thread("open")],
      teammates: [],
    });
  });

  it("splits Closura bots from the other founder's bots", () => {
    const threads = [
      thread("shared", "shared"),
      thread("mine", "kameron"),
      thread("other", "jeff"),
      thread("agents", "agent-only"),
      thread("open"),
    ];
    expect(partitionBotGroups(threads, "kameron")).toEqual({
      mine: [thread("mine", "kameron")],
      closura: [thread("shared", "shared"), thread("agents", "agent-only"), thread("open")],
      teammates: [thread("other", "jeff")],
    });
    expect(partitionBotGroups(threads, "jeff")).toEqual({
      mine: [thread("other", "jeff")],
      closura: [thread("shared", "shared"), thread("agents", "agent-only"), thread("open")],
      teammates: [thread("mine", "kameron")],
    });
  });

  it("lists a founder's CoS only when that founder's inbox is shown", () => {
    const jeffsCos = thread("jeff-cos", "shared", "CoS", "jeff");
    const filedCos = thread("filed-cos", "jeff", "Chief of Staff");
    const kameronsCos = thread("kameron-cos", "shared", "CoS", "kameron");
    const threads = [jeffsCos, filedCos, kameronsCos, thread("cto", "shared", "CTO", "jeff")];
    const ids = (viewer: "kameron" | "jeff", shownInboxes: string[]) => {
      const groups = partitionBotGroups(threads, viewer, {
        shownInboxes,
        machineOwnerOf: (bot) => bot.machine,
      });
      return [...groups.mine, ...groups.closura, ...groups.teammates].map((bot) => bot.id);
    };
    expect(ids("kameron", ["kameron", "agents", "shared"])).toEqual(["kameron-cos", "cto"]);
    expect(ids("kameron", ["kameron", "jeff", "agents", "shared"])).toEqual([
      "jeff-cos",
      "kameron-cos",
      "cto",
      "filed-cos",
    ]);
    expect(ids("jeff", ["jeff", "agents", "shared"])).toEqual(["filed-cos", "jeff-cos", "cto"]);
  });
});
