import { describe, expect, it } from "vite-plus/test";

import {
  TYPING_TTL_MS,
  applyTypingSnapshot,
  liveFounders,
  rosterAfterReport,
  typingLabel,
} from "./typingPresence.ts";

describe("typing presence", () => {
  it("keeps a beat until the window ends, and never shows a session assigned to nobody", () => {
    const now = 10_000;
    const typing = rosterAfterReport(new Map(), "kameron-laptop", "kameron", true, now);
    const both = rosterAfterReport(typing, "jeff-phone", "jeff", true, now + 10);
    expect(liveFounders(both, now + 10)).toEqual(["kameron", "jeff"]);
    const nobody = rosterAfterReport(both, "guest", null, true, now + 10);
    expect(liveFounders(nobody, now + 10)).toEqual(["kameron", "jeff"]);
    expect(liveFounders(both, now + TYPING_TTL_MS)).toEqual(["jeff"]);
    expect(liveFounders(both, now + 10 + TYPING_TTL_MS)).toEqual([]);
    const stopped = rosterAfterReport(both, "jeff-phone", "jeff", false, now + 20);
    expect(stopped.has("jeff-phone")).toBe(false);
    expect(rosterAfterReport(stopped, "missing", "jeff", false, now)).toBe(stopped);
  });

  it("folds snapshots and drops a thread when nobody is left", () => {
    const once = applyTypingSnapshot({}, { threadId: "a", founders: ["jeff"] });
    const both = applyTypingSnapshot(once, { threadId: "b", founders: ["kameron", "jeff"] });
    expect(both).toEqual({ a: ["jeff"], b: ["kameron", "jeff"] });
    expect(applyTypingSnapshot(both, { threadId: "missing", founders: [] })).toBe(both);
    expect(applyTypingSnapshot(both, { threadId: "a", founders: [] })).toEqual({
      b: ["kameron", "jeff"],
    });
    expect(typingLabel(["jeff"])).toBe("Jeff is typing");
    expect(typingLabel(["kameron", "jeff"])).toBe("Kameron and Jeff are typing");
    expect(typingLabel([])).toBeNull();
  });
});
