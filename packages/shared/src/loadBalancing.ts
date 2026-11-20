import type { HostResourcesSnapshot } from "@t3tools/contracts";

const GiB = 1024 ** 3;

/**
 * Headroom a machine must keep after placement. A headless machine is full near its limits;
 * an interactive one, a person's computer, is full long before it would feel slow to them.
 */
const LIMITS = {
  headless: { cpu: 0.95, loadPerCpu: 1, memoryShare: 0.05, memoryBytes: 1.5 * GiB, agents: null },
  interactive: { cpu: 0.5, loadPerCpu: 0.5, memoryShare: 0.4, memoryBytes: 3 * GiB, agents: 2 },
} as const;

export interface PlacementHostCap {
  readonly maxLanes: number;
  readonly minAvailableMemoryBytes: number;
}

export function withinHostCap(
  resources: HostResourcesSnapshot | null,
  cap: PlacementHostCap | undefined,
): boolean {
  if (cap === undefined) return true;
  if (resources === null) return false;
  const lanes = resources.runningAgents;
  return (
    lanes !== undefined &&
    lanes < cap.maxLanes &&
    resources.availableMemoryBytes >= cap.minAvailableMemoryBytes
  );
}

function headroom(
  resources: HostResourcesSnapshot,
  tier: keyof typeof LIMITS,
  cap: PlacementHostCap | undefined,
): number | null {
  const limits = LIMITS[tier];
  const { cpuUtilization, cpuCount, totalMemoryBytes, availableMemoryBytes } = resources;
  if (cpuUtilization === null || totalMemoryBytes <= 0 || cpuCount <= 0) return null;
  // A headless machine that cannot report load (Windows) or agents (no systemd) is judged
  // without them; someone's computer never is.
  const loadPerCpu = resources.loadPerCpu ?? (tier === "headless" ? 0 : null);
  const agents = resources.runningAgents ?? (tier === "headless" ? 0 : null);
  if (loadPerCpu === null || agents === null) return null;
  const memoryAvailable = availableMemoryBytes / totalMemoryBytes;
  if (
    cpuUtilization >= limits.cpu ||
    loadPerCpu >= limits.loadPerCpu ||
    memoryAvailable <= limits.memoryShare ||
    availableMemoryBytes < limits.memoryBytes ||
    (limits.agents !== null && agents >= limits.agents)
  )
    return null;
  if (!withinHostCap(resources, cap)) return null;
  // Run queues past the core count show saturation that a short CPU sample can miss.
  const busy = Math.max(cpuUtilization, Math.min(1, loadPerCpu));
  return (cpuCount * (1 - busy) * memoryAvailable) / (1 + agents);
}

/**
 * Callers supply only connected machines hosting the project and selected provider. Headless
 * machines take work first; an interactive machine is chosen only when no headless one has room,
 * its person is not using it, and it stays well clear of its limits. A machine that does not
 * report its role, such as one on an older release, counts as someone's computer in use.
 *
 * Within a tier the lowest `rank` with room wins, then the most room. A `cap` refuses a machine
 * at its lane count or memory floor, and one that cannot report its lanes. When nothing has room
 * the answer is null, never the machine the work started on.
 */
export function chooseLoadBalancedEnvironment(
  candidates: ReadonlyArray<{
    environmentId: string;
    resources: HostResourcesSnapshot | null;
    /** Client receipt time avoids comparing clocks on different machines. */
    receivedAt?: number;
    weight: number;
    rank?: number | undefined;
    cap?: PlacementHostCap | undefined;
  }>,
  now: number,
): string | null {
  const best = {
    headless: { id: null as string | null, rank: Infinity, score: 0 },
    interactive: { id: null as string | null, rank: Infinity, score: 0 },
  };
  for (const { environmentId, resources, receivedAt, weight, rank, cap } of candidates) {
    const sampledAt = receivedAt ?? resources?.sampledAt ?? 0;
    if (
      !resources ||
      !Number.isFinite(weight) ||
      weight <= 0 ||
      now - sampledAt > 15_000 ||
      sampledAt > now + 5_000
    ) {
      continue;
    }
    // A machine that does not say is someone's until it says otherwise, and in use if unsure.
    const tier = resources.placementRole === "headless" ? "headless" : "interactive";
    if (tier === "interactive" && resources.humanActive !== false) continue;
    const room = headroom(resources, tier, cap);
    if (room === null) continue;
    const score = weight * room;
    const order = rank ?? Infinity;
    const current = best[tier];
    if (order < current.rank || (order === current.rank && score > current.score))
      best[tier] = { id: environmentId, rank: order, score };
  }
  return best.headless.id ?? best.interactive.id;
}
