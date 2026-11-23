import { describe, expect, it } from "vite-plus/test";

import { mentionedFounders, resolveBotAttention } from "./botAttention.ts";
import { makeThreadInbox, type ThreadInbox } from "./threadInbox.ts";

const bot = { kind: "agent", id: "lead" } as const;

const inbox = (patch: Partial<ThreadInbox> = {}): ThreadInbox => ({
  ...makeThreadInbox({ actor: bot }),
  ...patch,
});

const ask = (founder: "kameron" | "jeff") => ({
  founder,
  kind: "decision" as const,
  question: "Ship it?",
  requestedAt: "2026-11-20T00:00:00.000Z",
});

describe("mentionedFounders", () => {
  it("names only a whole founder mention", () => {
    expect(mentionedFounders("loop in @Jeff and @kameron")).toEqual(["kameron", "jeff"]);
    expect(mentionedFounders("mail @jefferson about it")).toEqual([]);
    expect(mentionedFounders("@Jeff's draft")).toEqual(["jeff"]);
    expect(mentionedFounders(null)).toEqual([]);
  });
});

describe("resolveBotAttention", () => {
  it("stays quiet for ordinary work, even when its attention is action", () => {
    expect(
      resolveBotAttention({
        inbox: inbox({ attentionKind: "action" }),
        viewingFounder: "kameron",
      }),
    ).toEqual({ kind: "quiet" });
    expect(resolveBotAttention({ inbox: null, viewingFounder: "jeff" })).toEqual({
      kind: "quiet",
    });
  });

  it("shows a subtle dot for FYI chatter", () => {
    const shared = inbox({ audience: "shared", attentionKind: "FYI", reason: "fyi" });
    expect(resolveBotAttention({ inbox: shared, viewingFounder: "kameron" })).toEqual({
      kind: "fyi",
    });
    // FYI stays a dot even when nobody is signed in as a founder.
    expect(resolveBotAttention({ inbox: shared, viewingFounder: undefined })).toEqual({
      kind: "fyi",
    });
  });

  it("badges only an open decision or a founder mention", () => {
    expect(
      resolveBotAttention({
        inbox: inbox({ decisionRequest: ask("jeff") }),
        viewingFounder: "jeff",
      }).kind,
    ).toBe("badge");
    expect(
      resolveBotAttention({
        inbox: inbox({ decisionRequest: { ...ask("kameron"), kind: "approval" } }),
        viewingFounder: "kameron",
      }),
    ).toEqual({ kind: "badge", label: "Approval" });
    expect(
      resolveBotAttention({
        inbox: inbox(),
        viewingFounder: "kameron",
        latestText: "please look @Jeff",
      }),
    ).toEqual({ kind: "badge", label: "Jeff" });
  });

  it("lets a mention or a decision outrank the FYI dot", () => {
    const shared = inbox({ audience: "shared", attentionKind: "FYI", reason: "fyi" });
    expect(
      resolveBotAttention({ inbox: shared, viewingFounder: "jeff", latestText: "cc @Kameron" })
        .kind,
    ).toBe("badge");
    expect(
      resolveBotAttention({
        inbox: { ...shared, decisionRequest: ask("jeff") },
        viewingFounder: "jeff",
      }).kind,
    ).toBe("badge");
  });

  it("shows both founders' answers on a joint sign-off", () => {
    const signOff = [
      { founder: "jeff" as const, signed: false },
      { founder: "kameron" as const, signed: true },
    ];
    expect(
      resolveBotAttention({
        inbox: inbox({ decisionRequest: { ...ask("kameron"), signOff } }),
        viewingFounder: "jeff",
      }),
    ).toEqual({
      kind: "sign-off",
      founders: [
        { founder: "kameron", signed: true },
        { founder: "jeff", signed: false },
      ],
    });
  });

  it("badges names the shell already resolved, and not text it was not given", () => {
    expect(
      resolveBotAttention({
        inbox: inbox(),
        viewingFounder: "kameron",
        mentioned: ["jeff"],
        latestText: "cc @Kameron",
      }),
    ).toEqual({ kind: "badge", label: "Jeff" });
    expect(
      resolveBotAttention({
        inbox: inbox(),
        viewingFounder: "kameron",
        mentioned: [],
        latestText: "cc @Kameron",
      }),
    ).toEqual({ kind: "quiet" });
  });

  it("keeps a one-founder ask as a badge", () => {
    expect(
      resolveBotAttention({
        inbox: inbox({
          decisionRequest: { ...ask("kameron"), signOff: [{ founder: "kameron", signed: false }] },
        }),
        viewingFounder: "kameron",
      }).kind,
    ).toBe("badge");
  });
});
