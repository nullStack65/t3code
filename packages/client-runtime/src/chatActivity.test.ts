import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chatActivityContext,
  combineTimelineVisibilityStamps,
  isChatActivityMessage,
} from "./chatActivity.ts";

const botRun = RunId.make("bot-run");
const directRun = RunId.make("direct-run");
const at = "2026-01-01T00:00:00.000Z";
const relay = { role: "user", text: "relay", createdBy: "agent" as const };
const person = {
  role: "user",
  text: "hi",
  sentBy: {
    sessionId: "session" as never,
    device: "laptop",
    deviceType: "desktop" as const,
    founder: "kameron" as const,
  },
};
const context = chatActivityContext(
  [
    { createdAt: at, runId: botRun, message: relay },
    { createdAt: at, runId: directRun, message: person },
  ],
  [],
  false,
);

describe("isChatActivityMessage with a timeline stamp", () => {
  it("keeps the run-based default for messages without a stamp", () => {
    const reply = { role: "assistant", text: "done" };
    expect(isChatActivityMessage(reply, botRun, context)).toBe(true);
    expect(isChatActivityMessage(reply, directRun, context)).toBe(false);
    expect(isChatActivityMessage(relay, botRun, context)).toBe(true);
    expect(isChatActivityMessage(person, directRun, context)).toBe(false);
  });

  it("lets user_timeline lift a message out of an agent-started run", () => {
    const reply = { role: "assistant", text: "done", timelineVisibility: "user_timeline" } as const;
    expect(isChatActivityMessage(reply, botRun, context)).toBe(false);
    expect(
      isChatActivityMessage({ ...relay, timelineVisibility: "user_timeline" }, botRun, context),
    ).toBe(false);
  });

  it("lets agent_fold fold a message the default would show", () => {
    const reply = { role: "assistant", text: "done", timelineVisibility: "agent_fold" } as const;
    expect(isChatActivityMessage(reply, directRun, context)).toBe(true);
  });
});

describe("combineTimelineVisibilityStamps", () => {
  it.each([
    [[], undefined],
    [[undefined, undefined], undefined],
    [[undefined, "agent_fold"], "agent_fold"],
    [["agent_fold", "user_timeline", undefined], "user_timeline"],
    [["user_timeline", "agent_fold"], "user_timeline"],
  ] as const)("%j combines to %s", (stamps, expected) => {
    expect(combineTimelineVisibilityStamps(stamps)).toBe(expected);
  });
});
