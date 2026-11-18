import type { EnvironmentId, Founder, ThreadId, ThreadInbox } from "@t3tools/contracts";
import { ThreadAttribution } from "@t3tools/contracts/settings";

export const THREAD_ATTRIBUTIONS = ThreadAttribution.literals;

export const THREAD_ATTRIBUTION_LABELS: Record<ThreadAttribution, string> = {
  kameron: "Kameron",
  "kameron-agents": "Kameron's agents",
  jeff: "Jeff",
  "jeff-agents": "Jeff's agents",
  unknown: "Unknown",
};

export interface AttributableThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly lineage: { readonly parentThreadId: ThreadId | null };
  readonly source: {
    readonly inbox?: ThreadInbox | null | undefined;
    readonly createdBy?: string | undefined;
  };
}

/** Machine owners, chosen in Settings; nothing is assumed for an unmapped machine. */
type FounderByEnvironmentId = Readonly<Partial<Record<EnvironmentId, Founder>>>;

export const threadAttributionKey = (thread: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
}) => `${thread.environmentId}:${thread.id}`;

const attributionOf = (founder: Founder, byAgent: boolean): ThreadAttribution =>
  byAgent ? `${founder}-agents` : founder;

const founderOfAttribution = (attribution: ThreadAttribution): Founder | null =>
  attribution === "unknown" ? null : attribution.startsWith("jeff") ? "jeff" : "kameron";

const humanFounder = (actor: ThreadInbox["origin"] | undefined): Founder | null =>
  actor?.kind === "human" ? actor.id : null;

/**
 * Resolves every thread's attribution, keyed by `threadAttributionKey`. A human origin or
 * requester is that founder; agent work takes its requester's or owner's founder, else its
 * parent's; only history without inbox fields falls back to the machine's owner.
 */
export function resolveThreadAttributions(
  threads: ReadonlyArray<AttributableThread>,
  founderByEnvironmentId: FounderByEnvironmentId,
): ReadonlyMap<string, ThreadAttribution> {
  const byKey = new Map(threads.map((thread) => [threadAttributionKey(thread), thread]));
  const resolved = new Map<string, ThreadAttribution>();
  const resolving = new Set<string>();
  const resolve = (key: string, thread: AttributableThread): ThreadAttribution => {
    const known = resolved.get(key);
    if (known !== undefined) return known;
    // A lineage cycle resolves the repeated thread without its parent.
    resolving.add(key);
    const inbox = thread.source.inbox;
    const byAgent = inbox?.origin?.kind === "agent" || thread.source.createdBy === "agent";
    const parentKey =
      thread.lineage.parentThreadId === null
        ? null
        : `${thread.environmentId}:${thread.lineage.parentThreadId}`;
    const parent =
      parentKey === null || resolving.has(parentKey) ? undefined : byKey.get(parentKey);
    const founder =
      humanFounder(inbox?.origin) ??
      humanFounder(inbox?.requestedBy) ??
      (inbox?.origin?.kind === "agent"
        ? (inbox.owner ??
          (parent && parentKey ? founderOfAttribution(resolve(parentKey, parent)) : null))
        : null) ??
      // Only history from before inbox routing falls back to the machine: a shared machine
      // runs both founders' agents, so crediting routed work to its owner would be a guess.
      (inbox ? null : founderByEnvironmentId[thread.environmentId]) ??
      null;
    const attribution =
      founder === null
        ? "unknown"
        : attributionOf(founder, byAgent && humanFounder(inbox?.origin) === null);
    resolving.delete(key);
    resolved.set(key, attribution);
    return attribution;
  };
  for (const [key, thread] of byKey) resolve(key, thread);
  return resolved;
}
