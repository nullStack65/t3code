import { describe, expect, it } from "@effect/vitest";

import { pooledSegmentCaption } from "./pooledSegmentCaption";

describe("pooledSegmentCaption", () => {
  const held = {
    email: "a@example.com",
    displayName: null,
    status: "held" as const,
  };

  it("keeps Held on a wide bar when the emailed name is hidden", () => {
    expect(pooledSegmentCaption(held, "AE · Held", false)).toBe("Held");
    expect(pooledSegmentCaption({ ...held, status: "signed-out" }, "AE · Sign in", false)).toBe(
      "Sign in",
    );
  });

  it("leaves an unnamed emailed seat as the chip", () => {
    expect(pooledSegmentCaption({ ...held, status: null }, "AE", false)).toBeNull();
  });

  it("shows the full name once the segment is wide enough", () => {
    expect(
      pooledSegmentCaption(
        { ...held, displayName: "A Person · SuperGrok" },
        "A Person · SuperGrok · Held",
        true,
      ),
    ).toBe("A Person · SuperGrok · Held");
  });
});
