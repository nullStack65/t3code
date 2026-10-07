import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  monotonicNowMs,
  recordPostStartObservationReceipt,
  recordSnapshotObservationReceipts,
  resetPostStartObservationReceipts,
  resolvePostStartObservationReceipt,
} from "./postStartObservationReceipt.ts";

const ENV = "env-1";

beforeEach(() => {
  resetPostStartObservationReceipts();
});

describe("postStartObservationReceipt", () => {
  it("records the basis when the state accepts the bytes, not when a view reads them", () => {
    recordSnapshotObservationReceipts(
      ENV,
      [{ id: "thread-a", postStartActivity: { observedAt: "observed-1" } }],
      { wallMs: 1_000, monotonicMs: 10 },
    );
    // A later read (cached navigation, a preference remount, a render) reuses
    // the original receipt.
    const later = resolvePostStartObservationReceipt(ENV, "thread-a", "observed-1");
    expect(later).toEqual({ wallMs: 1_000, monotonicMs: 10 });
  });

  it("replaces the basis only for a genuinely new observation of that thread", () => {
    recordSnapshotObservationReceipts(
      ENV,
      [{ id: "thread-a", postStartActivity: { observedAt: "observed-1" } }],
      { wallMs: 1_000, monotonicMs: 10 },
    );
    recordSnapshotObservationReceipts(
      ENV,
      [{ id: "thread-a", postStartActivity: { observedAt: "observed-2" } }],
      { wallMs: 2_000, monotonicMs: 20 },
    );
    expect(resolvePostStartObservationReceipt(ENV, "thread-a", "observed-1")).toBeNull();
    expect(resolvePostStartObservationReceipt(ENV, "thread-a", "observed-2")).toEqual({
      wallMs: 2_000,
      monotonicMs: 20,
    });
  });

  it("keeps a current observation's basis while other threads churn past the old limit", () => {
    recordPostStartObservationReceipt(ENV, "thread-a", "a-quiet", {
      wallMs: 1_000,
      monotonicMs: 10,
    });
    // More than the old 512-entry FIFO's worth of distinct observations from
    // other threads, with the still-current observation present in every
    // accepted snapshot. A current observation must not be evicted or re-dated.
    for (let index = 0; index < 600; index += 1) {
      recordSnapshotObservationReceipts(
        ENV,
        [
          { id: "thread-a", postStartActivity: { observedAt: "a-quiet" } },
          { id: `thread-b-${index}`, postStartActivity: { observedAt: `b-${index}` } },
        ],
        { wallMs: 2_000 + index, monotonicMs: 20 + index },
      );
    }
    expect(resolvePostStartObservationReceipt(ENV, "thread-a", "a-quiet")).toEqual({
      wallMs: 1_000,
      monotonicMs: 10,
    });
  });

  it("does not retain a growing history of every sampled timestamp", () => {
    for (let index = 0; index < 100; index += 1) {
      recordPostStartObservationReceipt(ENV, "thread-a", `sample-${index}`, {
        wallMs: index,
        monotonicMs: index,
      });
    }
    // Only the latest observation for the thread is retained; earlier samples
    // are gone rather than accumulating.
    expect(resolvePostStartObservationReceipt(ENV, "thread-a", "sample-98")).toBeNull();
    expect(resolvePostStartObservationReceipt(ENV, "thread-a", "sample-99")).not.toBeNull();
  });

  it("scopes the basis by environment and thread", () => {
    recordSnapshotObservationReceipts(
      "env-1",
      [{ id: "thread-a", postStartActivity: { observedAt: "observed-1" } }],
      { wallMs: 1_000, monotonicMs: 10 },
    );
    expect(resolvePostStartObservationReceipt("env-2", "thread-a", "observed-1")).toBeNull();
    expect(resolvePostStartObservationReceipt("env-1", "thread-b", "observed-1")).toBeNull();
  });

  it("keeps delimiter-containing environment and thread IDs distinct during cleanup", () => {
    recordSnapshotObservationReceipts(
      "env=a",
      [{ id: "thread=b:c", postStartActivity: { observedAt: "first" } }],
      { wallMs: 1_000, monotonicMs: 10 },
    );
    recordSnapshotObservationReceipts(
      "env=a:b",
      [{ id: "c", postStartActivity: { observedAt: "second" } }],
      { wallMs: 2_000, monotonicMs: 20 },
    );

    expect(resolvePostStartObservationReceipt("env=a", "thread=b:c", "first")).toEqual({
      wallMs: 1_000,
      monotonicMs: 10,
    });
    expect(resolvePostStartObservationReceipt("env=a:b", "c", "second")).toEqual({
      wallMs: 2_000,
      monotonicMs: 20,
    });

    recordSnapshotObservationReceipts("env=a", [], { wallMs: 3_000, monotonicMs: 30 });
    expect(resolvePostStartObservationReceipt("env=a", "thread=b:c", "first")).toBeNull();
    expect(resolvePostStartObservationReceipt("env=a:b", "c", "second")).toEqual({
      wallMs: 2_000,
      monotonicMs: 20,
    });
  });

  it("exposes a monotonic clock reading", () => {
    expect(Number.isFinite(monotonicNowMs())).toBe(true);
  });
});
