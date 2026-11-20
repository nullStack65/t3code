import { describe, expect, it } from "vite-plus/test";

import { CODEX_COMPACTION_LOOP_LIMIT, recordCompaction } from "./CompactionLoopGuard.ts";

const replay = (offsetsMs: ReadonlyArray<number>) => {
  let history: ReadonlyArray<number> = [];
  return offsetsMs.map((offset) => {
    const result = recordCompaction(history, offset);
    history = result.history;
    return result.tripped;
  });
};

describe("recordCompaction", () => {
  it("defaults to three compactions within five minutes", () => {
    expect(CODEX_COMPACTION_LOOP_LIMIT.compactions).toBe(3);
    expect(CODEX_COMPACTION_LOOP_LIMIT.windowMs).toBe(300_000);
  });

  it("trips on the third compaction of a thrash sequence", () => {
    expect(replay([0, 40_000, 80_000])).toEqual([false, false, true]);
  });

  it("trips once per loop and again if the loop continues", () => {
    expect(replay([0, 30_000, 60_000, 60_005, 90_000, 120_000])).toEqual([
      false,
      false,
      true,
      false,
      false,
      true,
    ]);
  });

  it("does not trip on normally spaced compactions", () => {
    expect(replay([0, 6 * 60_000, 12 * 60_000, 18 * 60_000])).toEqual([false, false, false, false]);
  });

  it("drops compactions that fell out of the window", () => {
    expect(replay([0, 200_000, 310_000, 400_000])).toEqual([false, false, false, true]);
  });

  it("counts the paired signals of one compaction once", () => {
    expect(replay([0, 5, 60_000, 60_010])).toEqual([false, false, false, false]);
  });
});
