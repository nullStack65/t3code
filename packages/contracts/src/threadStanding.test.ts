import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

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
