import { AuthSessionId, EnvironmentId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  founderSenderBadge,
  messageSenderDetail,
  messageSenderLabel,
  messageSenderMatches,
  resolveMessageSender,
  sameMessageSender,
} from "./messageSender.ts";

const sentBy = (founder: "kameron" | "jeff" | null, device = "Work laptop") => ({
  sessionId: AuthSessionId.make(`session:${founder ?? "spare"}`),
  device,
  deviceType: "desktop" as const,
  founder,
});

describe("resolveMessageSender", () => {
  it("names the founder and device a stamped message came from", () => {
    const jeff = resolveMessageSender({ role: "user", text: "hi", sentBy: sentBy("jeff") });
    expect(messageSenderLabel(jeff)).toBe("Jeff");
    expect(messageSenderDetail(jeff)).toBe("Work laptop");
    expect(messageSenderMatches(jeff, "jeff")).toBe(true);
    expect(messageSenderMatches(jeff, "kameron")).toBe(false);
    expect(messageSenderMatches(jeff, "people")).toBe(true);
  });

  it("never guesses a sender for an old message", () => {
    const legacy = resolveMessageSender({ role: "user", text: "from before stamping" });
    expect(legacy).toEqual({ kind: "person", sentBy: null });
    expect(messageSenderLabel(legacy)).toBe("Unknown sender");
    expect(messageSenderDetail(legacy)).toBeNull();
    expect(messageSenderMatches(legacy, "kameron")).toBe(false);
    expect(messageSenderMatches(legacy, "jeff")).toBe(false);
    const unassigned = resolveMessageSender({ role: "user", text: "x", sentBy: sentBy(null, "") });
    expect(messageSenderLabel(unassigned)).toBe("Unknown person");
    expect(messageSenderDetail(unassigned)).toBe("Desktop");
  });

  it("keeps a relayed message with the thread that sent it", () => {
    const relayed = resolveMessageSender({
      role: "user",
      text: "Kameron says: ship it",
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: ThreadId.make("thread:lead"),
      linkedSender: {
        environmentId: EnvironmentId.make("environment:box"),
        threadId: ThreadId.make("thread:lead"),
        title: "Lead lane",
      },
      // Even a forged stamp cannot make a relay a founder's own message.
      sentBy: sentBy("kameron"),
    });
    expect(relayed.kind).toBe("agent");
    expect(messageSenderLabel(relayed)).toBe("Lead lane");
    expect(messageSenderLabel(relayed, "Lead (renamed)")).toBe("Lead (renamed)");
    expect(messageSenderMatches(relayed, "agents")).toBe(true);
    expect(messageSenderMatches(relayed, "kameron")).toBe(false);
    expect(messageSenderMatches(relayed, "people")).toBe(false);
  });

  it("sorts model replies, automations and notices", () => {
    const reply = resolveMessageSender(
      { role: "assistant", text: "done" },
      { provider: "Claude", model: "claude-opus-5-5" },
    );
    expect(messageSenderLabel(reply)).toBe("Claude");
    expect(messageSenderDetail(reply)).toBe("claude-opus-5-5");
    expect(messageSenderMatches(reply, "model")).toBe(true);

    const automation = resolveMessageSender({
      role: "user",
      text: "nightly digest",
      scheduledTaskId: ScheduledTaskId.make("task:nightly"),
    });
    expect(messageSenderLabel(automation)).toBe("Automation");
    expect(messageSenderMatches(automation, "agents")).toBe(true);

    // A person's stamp wins over a client-supplied automation id: a client cannot hide as one.
    const disguised = resolveMessageSender({
      role: "user",
      text: "looks scheduled",
      createdBy: "user",
      scheduledTaskId: ScheduledTaskId.make("task:nightly"),
      sentBy: sentBy("jeff"),
    });
    expect(messageSenderLabel(disguised)).toBe("Jeff");
    expect(messageSenderMatches(disguised, "agents")).toBe(false);

    const notice = resolveMessageSender({ role: "user", text: "x", createdBy: "system" });
    expect(messageSenderLabel(notice)).toBe("T3 Code");
    expect(messageSenderMatches(notice, "system")).toBe(true);
    expect(resolveMessageSender({ role: "system", text: "x" }).kind).toBe("system");
  });

  it("groups consecutive messages from the same sender", () => {
    const a = resolveMessageSender({ role: "user", text: "a", sentBy: sentBy("kameron", "Phone") });
    const b = resolveMessageSender({ role: "user", text: "b", sentBy: sentBy("kameron") });
    const c = resolveMessageSender({ role: "user", text: "c", sentBy: sentBy("jeff") });
    expect(sameMessageSender(a, b)).toBe(true);
    expect(sameMessageSender(a, c)).toBe(false);
  });
});

describe("founderSenderBadge", () => {
  it("uses the founder's initial and name", () => {
    expect(founderSenderBadge("kameron")).toEqual({ name: "Kameron", initial: "K" });
    expect(founderSenderBadge("jeff")).toEqual({ name: "Jeff", initial: "J" });
  });
});
