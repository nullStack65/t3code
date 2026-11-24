import { deadlineStore } from "@t3tools/client-runtime/clock";
import { useState, useSyncExternalStore } from "react";

/** Re-renders once when `deadlineMs` (epoch ms) is reached; `null` never passes. */
export function useDeadlinePassed(deadlineMs: number | null): boolean {
  const store = deadlineStore(deadlineMs);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * `Date.now()` captured at mount and re-read when `deadlineMs` changes or
 * passes, so comparisons against the deadline flip exactly once.
 */
export function useNowAfter(deadlineMs: number | null): number {
  const passed = useDeadlinePassed(deadlineMs);
  const readNow = () => ({ deadlineMs, passed, nowMs: Date.now() });
  const [snapshot, setSnapshot] = useState(readNow);
  // The clock is read inside the updater: the compiler caches a bare
  // `Date.now()` in render once per instance, so a later adjustment would reuse
  // the first reading. React discards this render and re-runs with the update.
  if (snapshot.deadlineMs !== deadlineMs || snapshot.passed !== passed) setSnapshot(readNow);
  return snapshot.nowMs;
}

/**
 * `Date.now()` re-read as each of `deadlinesMs` passes, one timer at a time, so every
 * comparison against any of them flips exactly once.
 */
export function useNowAcross(deadlinesMs: ReadonlyArray<number>): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const next = deadlinesMs.reduce<number | null>(
    (soonest, deadline) =>
      deadline > nowMs && (soonest === null || deadline < soonest) ? deadline : soonest,
    null,
  );
  const passed = useDeadlinePassed(next);
  // As in useNowAfter, the clock is read inside the updater.
  if (passed) setNowMs(() => Date.now());
  return nowMs;
}
