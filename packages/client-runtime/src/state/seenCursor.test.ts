import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { seenCursorForViewer } from "./models.ts";

const earlier = DateTime.makeUnsafe("2026-11-20T12:00:00.000Z");
const later = DateTime.makeUnsafe("2026-11-20T13:00:00.000Z");

describe("seenCursorForViewer", () => {
  it("keeps the shared watermark until a founder map exists", () => {
    expect(
      seenCursorForViewer({ lastVisitedAt: earlier, inbox: { audience: "shared" } }, "jeff"),
    ).toBe(earlier);
    expect(seenCursorForViewer({ lastVisitedAt: undefined }, "jeff")).toBeUndefined();
  });

  it("uses only the viewer's stamp on a shared thread", () => {
    const thread = {
      lastVisitedAt: later,
      inbox: { audience: "shared" as const },
      visitsByFounder: { kameron: earlier },
    };
    expect(seenCursorForViewer(thread, "kameron")).toBe(earlier);
    expect(seenCursorForViewer(thread, "jeff")).toBeNull();
    expect(seenCursorForViewer(thread, null)).toBe(later);
  });

  it("ignores a founder map on a thread that is not shared", () => {
    expect(
      seenCursorForViewer(
        {
          lastVisitedAt: later,
          inbox: { audience: "jeff" },
          visitsByFounder: { jeff: earlier },
        },
        "jeff",
      ),
    ).toBe(later);
  });
});
