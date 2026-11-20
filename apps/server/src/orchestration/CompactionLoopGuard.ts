export const CODEX_COMPACTION_LOOP_LIMIT = {
  compactions: 3,
  windowMs: 5 * 60_000,
  duplicateSignalMs: 2_000,
} as const;

export type CompactionLoopLimit = {
  readonly compactions: number;
  readonly windowMs: number;
  readonly duplicateSignalMs: number;
};

export function recordCompaction(
  history: ReadonlyArray<number>,
  atMs: number,
  limit: CompactionLoopLimit = CODEX_COMPACTION_LOOP_LIMIT,
): { readonly history: ReadonlyArray<number>; readonly tripped: boolean } {
  const last = history.at(-1);
  if (last !== undefined && Math.abs(atMs - last) < limit.duplicateSignalMs) {
    return { history, tripped: false };
  }
  const recent = [...history.filter((at) => atMs - at < limit.windowMs), atMs];
  const tripped = recent.length >= limit.compactions;
  return { history: tripped ? [atMs] : recent, tripped };
}

export function describeCompactionLoop(limit: CompactionLoopLimit = CODEX_COMPACTION_LOOP_LIMIT) {
  const minutes = limit.windowMs / 60_000;
  return `Context compacted ${limit.compactions} times within ${minutes} minute${minutes === 1 ? "" : "s"}, so the turn was stopped instead of re-reading the full context again. It will not resume on its own. Send a new message, ideally with a narrower request, to continue.`;
}
