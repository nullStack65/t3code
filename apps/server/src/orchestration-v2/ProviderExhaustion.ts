/**
 * Provider instances this server has seen stop at a usage limit, and until when. A new launch on
 * one is refused up front instead of starting a run that fails at once and alerts. In memory and
 * process-wide on purpose: the first failure after a restart teaches it again, and every thread
 * on the account shares one limit.
 */
const exhaustedUntil = new Map<string, number>();
const MAX_TRACKED = 100;

export const ProviderExhaustion = {
  mark(instanceId: string, untilMs: number): void {
    exhaustedUntil.delete(instanceId);
    exhaustedUntil.set(instanceId, untilMs);
    for (const [key] of exhaustedUntil) {
      if (exhaustedUntil.size <= MAX_TRACKED) break;
      exhaustedUntil.delete(key);
    }
  },
  /** The epoch millisecond the instance is out until, or null when it is usable. */
  until(instanceId: string, nowMs: number): number | null {
    const until = exhaustedUntil.get(instanceId);
    if (until === undefined) return null;
    if (until <= nowMs) {
      exhaustedUntil.delete(instanceId);
      return null;
    }
    return until;
  },
  clear(instanceId?: string): void {
    if (instanceId === undefined) exhaustedUntil.clear();
    else exhaustedUntil.delete(instanceId);
  },
};
