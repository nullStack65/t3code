import {
  resolveThreadSenders,
  type EnvironmentId,
  type Founder,
  type SenderFounder,
  type ThreadId,
  type ThreadInbox,
  type ThreadSender,
} from "@t3tools/contracts";
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
    /** The server's resolution of the parent chain; wins over the parents this client holds. */
    readonly parentFounder?: SenderFounder | undefined;
  };
}

/** Machine owners; nothing is assumed for an unmapped machine. */
export type FounderByEnvironmentId = Readonly<Partial<Record<EnvironmentId, Founder>>>;

/** The part of a server config that names its machine's owner. */
export interface MachineOwnerConfig {
  /** The server reports its owner, so its value wins even when null. */
  readonly machineOwner?: boolean | undefined;
  readonly settings: { readonly ownerFounder: Founder | null };
}

/**
 * Every machine's owner: the one its server reports, so every client agrees, else this client's
 * own map for servers too old to report one.
 */
export function resolveMachineOwners(
  serverConfigs: ReadonlyMap<EnvironmentId, MachineOwnerConfig>,
  legacy: FounderByEnvironmentId | undefined,
): FounderByEnvironmentId {
  const owners: Partial<Record<EnvironmentId, Founder>> = { ...legacy };
  for (const [environmentId, config] of serverConfigs) {
    if (config.machineOwner !== true) continue;
    if (config.settings.ownerFounder === null) delete owners[environmentId];
    else owners[environmentId] = config.settings.ownerFounder;
  }
  return owners;
}

export const threadAttributionKey = (thread: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
}) => `${thread.environmentId}:${thread.id}`;

/** A sender's attribution once its machine's owner is known. */
export function attributionOfSender(
  sender: ThreadSender,
  owner: Founder | undefined,
): ThreadAttribution {
  const founder = sender.founder === "machine" ? (owner ?? null) : sender.founder;
  if (founder === null) return "unknown";
  return sender.byAgent ? `${founder}-agents` : founder;
}

/**
 * Resolves every thread's attribution, keyed by `threadAttributionKey`, with the rule servers
 * count older settled threads by (`resolveThreadSenders`).
 */
export function resolveThreadAttributions(
  threads: ReadonlyArray<AttributableThread>,
  founderByEnvironmentId: FounderByEnvironmentId,
): ReadonlyMap<string, ThreadAttribution> {
  const environmentByKey = new Map<string, EnvironmentId>();
  const senders = resolveThreadSenders(
    threads.map((thread) => {
      const key = threadAttributionKey(thread);
      environmentByKey.set(key, thread.environmentId);
      return {
        key,
        parentKey:
          thread.lineage.parentThreadId === null
            ? null
            : `${thread.environmentId}:${thread.lineage.parentThreadId}`,
        inbox: thread.source.inbox,
        createdBy: thread.source.createdBy,
        parentFounder: thread.source.parentFounder,
      };
    }),
  );
  const resolved = new Map<string, ThreadAttribution>();
  for (const [key, sender] of senders) {
    resolved.set(
      key,
      attributionOfSender(sender, founderByEnvironmentId[environmentByKey.get(key)!]),
    );
  }
  return resolved;
}
