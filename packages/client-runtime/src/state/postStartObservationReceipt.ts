/**
 * Client receipt basis for live post-start observations.
 *
 * The environment shell carries each thread's `postStartActivity` stamped with
 * a server instant (`observedAt`). Ages are meaningful only when paired with
 * the client instant that observation actually reached this client: a render,
 * a navigation, a preference remount, a reconnect or an unrelated shell update
 * is not a new receipt and must not re-date it.
 *
 * Receipts are recorded by the client state itself, at the moment a shell
 * snapshot is accepted (`recordSnapshotObservationReceipts`), not when a view
 * first consumes them. That makes the basis independent of whether notification
 * preferences are on, whether the thread is open, and which components have
 * mounted. Each environment/thread keeps only its *current* observation's
 * receipt, so unrelated traffic for other threads can never evict a live
 * observation; a genuinely newer observation for the same thread replaces the
 * old one.
 *
 * A receipt pairs a wall-clock instant with a monotonic baseline so elapsed
 * time is measured monotonically and a browser wall-clock change cannot
 * fabricate a silence age. This is not a clock-sync service: it only remembers
 * when bytes actually arrived.
 *
 * @module postStartObservationReceipt
 */
export type PostStartObservationReceipt = {
  readonly wallMs: number;
  readonly monotonicMs: number;
};

/** Minimal shape the shell state exposes for receipt recording. */
export type PostStartObservationThread = {
  readonly id: string;
  readonly postStartActivity?:
    | { readonly observedAt?: string | null | undefined }
    | null
    | undefined;
};

/**
 * Upper bound on tracked environment/thread pairs. Far larger than any real
 * shell (one entry per current observation, not per sample), so it only guards
 * against unbounded growth from pathological churn.
 */
const MAX_TRACKED_THREADS = 4_096;

type StoredReceipt = { readonly observedAt: string; readonly receipt: PostStartObservationReceipt };

const receiptsByThread = new Map<string, StoredReceipt>();

export function monotonicNowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : // @effect-diagnostics-next-line globalDate:off
      Date.now();
}

function threadKey(environmentId: string, threadId: string): string {
  return `${JSON.stringify(environmentId)}:${JSON.stringify(threadId)}`;
}

function makeReceipt(now: {
  readonly wallMs?: number | undefined;
  readonly monotonicMs?: number | undefined;
}): PostStartObservationReceipt {
  return {
    // @effect-diagnostics-next-line globalDate:off
    wallMs: now.wallMs ?? Date.now(),
    monotonicMs: now.monotonicMs ?? monotonicNowMs(),
  };
}

/**
 * Record (or reuse) the receipt for the observation currently held for a
 * thread. Re-sighting the same `observedAt` keeps the original receipt;
 * a genuinely new `observedAt` replaces it.
 */
export function recordPostStartObservationReceipt(
  environmentId: string,
  threadId: string,
  observedAt: string,
  now: {
    readonly wallMs?: number | undefined;
    readonly monotonicMs?: number | undefined;
  } = {},
): PostStartObservationReceipt {
  const key = threadKey(environmentId, threadId);
  const existing = receiptsByThread.get(key);
  if (existing !== undefined && existing.observedAt === observedAt) return existing.receipt;
  const receipt = makeReceipt(now);
  if (existing === undefined && receiptsByThread.size >= MAX_TRACKED_THREADS) {
    const oldest = receiptsByThread.keys().next().value;
    if (oldest !== undefined) receiptsByThread.delete(oldest);
  }
  receiptsByThread.set(key, { observedAt, receipt });
  return receipt;
}

/**
 * Record receipts for every observation accepted in a shell snapshot. Also
 * drops this environment's entries for threads that no longer carry an
 * observation, reusing the shell's own lifecycle instead of a separate sweep.
 */
export function recordSnapshotObservationReceipts(
  environmentId: string,
  threads: ReadonlyArray<PostStartObservationThread>,
  now: {
    readonly wallMs?: number | undefined;
    readonly monotonicMs?: number | undefined;
  } = {},
): void {
  // @effect-diagnostics-next-line globalDate:off
  const wallMs = now.wallMs ?? Date.now();
  const monotonicMs = now.monotonicMs ?? monotonicNowMs();
  const present = new Set<string>();
  for (const thread of threads) {
    const observedAt = thread.postStartActivity?.observedAt ?? null;
    if (observedAt === null) continue;
    present.add(threadKey(environmentId, thread.id));
    recordPostStartObservationReceipt(environmentId, thread.id, observedAt, {
      wallMs,
      monotonicMs,
    });
  }
  const prefix = `${JSON.stringify(environmentId)}:`;
  for (const key of [...receiptsByThread.keys()]) {
    if (key.startsWith(prefix) && !present.has(key)) receiptsByThread.delete(key);
  }
}

/**
 * The receipt for an observation, or null when none was recorded for this
 * thread's current `observedAt`. Callers pass that null through as honest
 * "unknown receipt" rather than inventing one at consumption time.
 */
export function resolvePostStartObservationReceipt(
  environmentId: string,
  threadId: string,
  observedAt: string,
): PostStartObservationReceipt | null {
  const entry = receiptsByThread.get(threadKey(environmentId, threadId));
  return entry !== undefined && entry.observedAt === observedAt ? entry.receipt : null;
}

export function resetPostStartObservationReceipts(): void {
  receiptsByThread.clear();
}
