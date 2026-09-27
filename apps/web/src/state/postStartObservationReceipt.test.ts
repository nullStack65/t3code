import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  monotonicNowMs,
  postStartObservationReceiptKey,
  rememberPostStartObservationReceipt,
  resetPostStartObservationReceipts,
} from "./postStartObservationReceipt";

beforeEach(() => {
  resetPostStartObservationReceipts();
});

describe("postStartObservationReceipt", () => {
  it("reuses the original receipt when the same observation is re-sighted", () => {
    const key = postStartObservationReceiptKey("env-1", "thread-a", "observed-1");
    const first = rememberPostStartObservationReceipt(key, { wallMs: 1_000, monotonicMs: 10 });
    // An unrelated shell update, render, navigation or preference remount keeps
    // the same observation object; the receipt must not be re-dated.
    const later = rememberPostStartObservationReceipt(key, {
      wallMs: 9_999_999,
      monotonicMs: 8_888_888,
    });
    expect(later).toEqual(first);
  });

  it("records a distinct receipt for a genuinely new observation", () => {
    const first = rememberPostStartObservationReceipt(
      postStartObservationReceiptKey("env-1", "thread-a", "observed-1"),
      { wallMs: 1, monotonicMs: 1 },
    );
    const second = rememberPostStartObservationReceipt(
      postStartObservationReceiptKey("env-1", "thread-a", "observed-2"),
      { wallMs: 2, monotonicMs: 2 },
    );
    expect(second).not.toEqual(first);
    expect(second.wallMs).toBe(2);
    expect(second.monotonicMs).toBe(2);
  });

  it("scopes receipts by environment and thread", () => {
    const a = postStartObservationReceiptKey("env-1", "thread-a", "observed-1");
    const b = postStartObservationReceiptKey("env-2", "thread-a", "observed-1");
    const c = postStartObservationReceiptKey("env-1", "thread-b", "observed-1");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("exposes a monotonic clock reading", () => {
    expect(Number.isFinite(monotonicNowMs())).toBe(true);
  });
});
