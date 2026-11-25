import { describe, expect, it } from "vite-plus/test";

import { mentionedFounders, resolveBotAttention } from "./botAttention.ts";
import { makeThreadInbox, type ThreadInbox } from "./threadInbox.ts";

const bot = { kind: "agent", id: "lead" } as const;

const inbox = (patch: Partial<ThreadInbox> = {}): ThreadInbox => ({
  ...makeThreadInbox({ actor: bot }),
  ...patch,
});

const shared = () => inbox({ audience: "shared", attentionKind: "FYI", reason: "fyi" });

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

  it("ignores names in code, emails and quoted logs, but not a ping beside them", () => {
    expect(mentionedFounders("run `git log @kameron` now")).toEqual([]);
    expect(mentionedFounders("```\nnotify @jeff\n```")).toEqual([]);
    expect(mentionedFounders("```\nnotify @jeff")).toEqual([]);
    expect(mentionedFounders("mail kameron.smith@closura.ai or ops@jeff.example")).toEqual([]);
    expect(mentionedFounders("> @kameron said ship\n  > @jeff too")).toEqual([]);
    expect(mentionedFounders("```\n@kameron\n```\nplease review @Jeff")).toEqual(["jeff"]);
    expect(mentionedFounders("> log @kameron\n`x`\n@kameron decide?")).toEqual(["kameron"]);
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
        inbox: shared(),
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
        inbox: shared(),
        viewingFounder: "kameron",
        mentioned: ["jeff"],
        latestText: "cc @Kameron",
      }),
    ).toEqual({ kind: "badge", label: "Jeff" });
    expect(
      resolveBotAttention({
        inbox: shared(),
        viewingFounder: "kameron",
        mentioned: [],
        latestText: "cc @Kameron",
      }),
    ).toEqual({ kind: "fyi" });
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

  describe("false founder pills", () => {
    const incidental = [
      "Kameron and Jeff were mentioned in the report",
      "see `@kameron` and `@jeff` in the config",
      "```\n@kameron @jeff\n```",
      "owner kameron.smith@closura.ai, cc jeff@closura.ai, ops@kameron.example",
      "> @kameron @jeff pinged earlier\nall green",
    ];

    it("never badges agent-only work on a name, even an explicit ping", () => {
      const agentOnly = inbox({ audience: "agent-only", attentionKind: "background" });
      for (const latestText of [...incidental, "@Kameron @Jeff please look"]) {
        expect(
          resolveBotAttention({ inbox: agentOnly, viewingFounder: "kameron", latestText }),
        ).toEqual({
          kind: "quiet",
        });
      }
      expect(
        resolveBotAttention({
          inbox: agentOnly,
          viewingFounder: "kameron",
          mentioned: ["kameron", "jeff"],
        }),
      ).toEqual({ kind: "quiet" });
    });

    it("still badges agent-only work that holds a decision request", () => {
      expect(
        resolveBotAttention({
          inbox: inbox({ audience: "agent-only", decisionRequest: ask("kameron") }),
          viewingFounder: "kameron",
          latestText: "@Jeff",
        }),
      ).toEqual({ kind: "badge", label: "Decision" });
    });

    it("keeps shared FYI chatter a dot when names only appear incidentally", () => {
      const fyi = inbox({
        audience: "shared",
        attentionKind: "FYI",
        reason: "fyi",
        assignee: null,
      });
      for (const latestText of incidental) {
        expect(resolveBotAttention({ inbox: fyi, viewingFounder: "kameron", latestText })).toEqual({
          kind: "fyi",
        });
      }
    });

    it("badges shared FYI work for a real ping or a decision request", () => {
      const fyi = inbox({
        audience: "shared",
        attentionKind: "FYI",
        reason: "fyi",
        assignee: null,
      });
      expect(
        resolveBotAttention({
          inbox: fyi,
          viewingFounder: "kameron",
          latestText: "```\n@kameron\n```\n@Jeff @Kameron can you approve?",
        }),
      ).toEqual({ kind: "badge", label: "Kameron · Jeff" });
      expect(
        resolveBotAttention({
          inbox: { ...fyi, decisionRequest: ask("jeff") },
          viewingFounder: "kameron",
          latestText: "see `@kameron`",
        }),
      ).toEqual({ kind: "badge", label: "Decision" });
    });
  });
});
