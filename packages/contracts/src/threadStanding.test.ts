import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { isOlderSettledThreadShell } from "./orchestrationV2.ts";

import { resolveThreadStanding, StoredThreadStanding } from "./threadStanding.ts";

describe("thread standing", () => {
  const decodeStored = Schema.decodeUnknownSync(StoredThreadStanding);

  it("keeps a newer peer's unknown avatar and accent, then resolves them to built-ins", () => {
    const stored = decodeStored({ name: "Synthetic", avatarId: "future", accent: "chartreuse" });
    expect(stored).toEqual({ name: "Synthetic", avatarId: "future", accent: "chartreuse" });
    expect(resolveThreadStanding(stored)).toEqual({
      name: "Synthetic",
      role: null,
      avatarId: "bolt",
      accent: "sky",
    });
  });

  it("reads a malformed value as an ordinary thread", () => {
    expect(decodeStored({ name: 3 })).toBeNull();
    expect(resolveThreadStanding(undefined)).toBeNull();
    expect(resolveThreadStanding({ name: "  ", avatarId: "bolt", accent: "sky" })).toBeNull();
  });
});

describe("isOlderSettledThreadShell", () => {
  it("never treats a standing bot as an older settled shell", () => {
    const settled = {
      lineage: { relationshipToParent: null, sideChat: false } as never,
      settledOverride: "settled" as const,
      settledAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
    };
    const later = Date.parse("2026-02-01T00:00:00Z");
    expect(isOlderSettledThreadShell(settled, later)).toBe(true);
    expect(
      isOlderSettledThreadShell(
        { ...settled, standing: { name: "Ops", avatarId: "bolt", accent: "sky" } },
        later,
      ),
    ).toBe(false);
  });
});
