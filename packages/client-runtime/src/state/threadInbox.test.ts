import { describe, expect, it } from "vite-plus/test";

import { inboxOwnerNames, threadVisibleInInbox, type ThreadInboxSubject } from "./threadInbox.ts";

const thread = (patch: Partial<ThreadInboxSubject> = {}): ThreadInboxSubject => ({
  owner: null,
  threadType: null,
  startedBy: null,
  ...patch,
});

describe("threadVisibleInInbox", () => {
  it("keeps untagged threads on the shared list", () => {
    expect(threadVisibleInInbox(thread(), { identity: null, showBotWork: false })).toBe(true);
    expect(threadVisibleInInbox({}, { identity: null, showBotWork: false })).toBe(true);
  });

  it("hides bot work until someone asks to see it", () => {
    const bot = thread({ owner: "Lead", threadType: "bot-work", startedBy: "Lead" });
    expect(threadVisibleInInbox(bot, { identity: null, showBotWork: false })).toBe(false);
    expect(threadVisibleInInbox(bot, { identity: "Lead", showBotWork: false })).toBe(false);
    expect(threadVisibleInInbox(bot, { identity: "Lead", showBotWork: true })).toBe(true);
  });

  it("shows a founder threads they own, that need them, or that they started", () => {
    const options = { identity: "Kameron", showBotWork: false };
    expect(threadVisibleInInbox(thread({ owner: "Kameron", threadType: "fyi" }), options)).toBe(
      true,
    );
    expect(
      threadVisibleInInbox(thread({ owner: "Kameron", threadType: "needs-human" }), options),
    ).toBe(true);
    expect(
      threadVisibleInInbox(
        thread({ owner: "Jeff", threadType: "fyi", startedBy: "Kameron" }),
        options,
      ),
    ).toBe(true);
    expect(
      threadVisibleInInbox(thread({ owner: "Jeff", threadType: "needs-human" }), options),
    ).toBe(false);
    expect(threadVisibleInInbox(thread(), options)).toBe(false);
  });
});

describe("inboxOwnerNames", () => {
  it("keeps the known founders and appends configured names once", () => {
    expect(inboxOwnerNames(["Ops", "Kameron", "  Ops  "])).toEqual([
      "Kameron",
      "Jeff",
      "Lead",
      "Jeff's Lead",
      "Ops",
    ]);
  });
});
