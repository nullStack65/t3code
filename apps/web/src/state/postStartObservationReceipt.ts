/**
 * Client receipt basis for live post-start observations.
 *
 * The environment shell carries each thread's `postStartActivity` stamped with
 * a server instant (`observedAt`). Ages are meaningful only when paired with
 * the client instant that observation actually reached this client: a render,
 * a navigation, a preference remount, a reconnect or an unrelated shell update
 * is not a new receipt and must not re-date it.
 *
 * This is a bounded memo keyed by `environmentId:threadId:observedAt`. The
 * first time a given observation is seen the receipt is recorded (wall clock
 * plus a monotonic baseline); every later sighting — including from another
 * component — reuses the original receipt. Elapsed time is then measured from
 * the monotonic baseline, so a browser wall-clock change between observations
 * cannot fabricate a silence age. Not a clock-sync service: it only remembers
 * when bytes actually arrived.
 *
 * @module postStartObservationReceipt
 */
export type PostStartObservationReceipt = {
  readonly wallMs: number;
  readonly monotonicMs: number;
};

const MAX_RECEIPTS = 512;
const receipts = new Map<string, PostStartObservationReceipt>();

export function monotonicNowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function postStartObservationReceiptKey(
  environmentId: string,
  threadId: string,
  observedAt: string,
): string {
  return `${environmentId}:${threadId}:${observedAt}`;
}

/**
 * Return the receipt for an observation, recording it on first sight. `now`
 * is injectable for controlled tests; production callers omit it.
 */
export function rememberPostStartObservationReceipt(
  key: string,
  now: { readonly wallMs?: number; readonly monotonicMs?: number } = {},
): PostStartObservationReceipt {
  const existing = receipts.get(key);
  if (existing !== undefined) return existing;
  const receipt: PostStartObservationReceipt = {
    wallMs: now.wallMs ?? Date.now(),
    monotonicMs: now.monotonicMs ?? monotonicNowMs(),
  };
  if (receipts.size >= MAX_RECEIPTS) {
    const oldest = receipts.keys().next().value;
    if (oldest !== undefined) receipts.delete(oldest);
  }
  receipts.set(key, receipt);
  return receipt;
}

export function resetPostStartObservationReceipts(): void {
  receipts.clear();
}
