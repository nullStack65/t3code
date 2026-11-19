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

function headroom(resources: HostResourcesSnapshot, tier: keyof typeof LIMITS): number | null {
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
 * `originEnvironmentId` is where the work starts. When nothing has room it keeps the work if it
 * has room by headless limits, as before placement could pick: work started on someone's
 * computer is theirs to run there.
 */
export function chooseLoadBalancedEnvironment(
  candidates: ReadonlyArray<{
    environmentId: string;
    resources: HostResourcesSnapshot | null;
    /** Client receipt time avoids comparing clocks on different machines. */
    receivedAt?: number;
    weight: number;
  }>,
  now: number,
  originEnvironmentId?: string,
): string | null {
  const best = {
    headless: { id: null as string | null, score: 0 },
    interactive: { id: null as string | null, score: 0 },
  };
  let origin: string | null = null;
  for (const { environmentId, resources, receivedAt, weight } of candidates) {
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
    if (environmentId === originEnvironmentId && headroom(resources, "headless") !== null)
      origin = environmentId;
    // A machine that does not say is someone's until it says otherwise, and in use if unsure.
    const tier = resources.placementRole === "headless" ? "headless" : "interactive";
    if (tier === "interactive" && resources.humanActive !== false) continue;
    const room = headroom(resources, tier);
    if (room === null) continue;
    const score = weight * room;
    if (score > best[tier].score) best[tier] = { id: environmentId, score };
  }
  return best.headless.id ?? best.interactive.id ?? origin;
}
