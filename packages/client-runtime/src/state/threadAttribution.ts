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

/** The thread an agent launched this one from: the agent origin's thread, else its parent. */
export function launchingThreadIdOf(thread: AttributableThread): string | null {
  const origin = thread.source.inbox?.origin;
  // Launches without a calling thread record the bare id "agent".
  if (origin?.kind === "agent" && origin.id !== "agent") return origin.id;
  return origin?.kind === "agent" || thread.source.createdBy === "agent"
    ? thread.lineage.parentThreadId
    : null;
}

/** The sentence form of an attribution, naming the launching thread for agent work. */
export function threadSenderLine(
  attribution: ThreadAttribution,
  launcherTitle: string | null,
): { readonly label: string; readonly byAgent: boolean } {
  const from = launcherTitle ? `, from “${launcherTitle}”` : "";
  if (attribution === "unknown")
    return launcherTitle
      ? { label: `An agent${from}`, byAgent: true }
      : { label: "Sender unknown", byAgent: false };
  const byAgent = attribution.endsWith("-agents");
  return { label: `${THREAD_ATTRIBUTION_LABELS[attribution]}${byAgent ? from : ""}`, byAgent };
}
