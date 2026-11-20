import type { HostResourcesSnapshot } from "@t3tools/contracts";
import { chooseLoadBalancedEnvironment, type PlacementHostCap } from "./loadBalancing.ts";

const GiB = 1024 ** 3;

/** Evidence the deciding server gathered itself; caller-supplied labels are not evidence. */
export interface ThreadPlacementCandidate {
  readonly environmentId: string;
  readonly resources: HostResourcesSnapshot | null;
  /** When this server received `resources`, so clocks on different machines are never compared. */
  readonly receivedAt: number;
  readonly weight: number;
  /** An authenticated link that may launch threads there; always true for this environment. */
  readonly operable: boolean;
  /** The work's repository has a project there. */
  readonly projectAvailable: boolean;
  /** The requested provider, model and modes run there. */
  readonly modelAvailable: boolean;
  readonly rank?: number | undefined;
  readonly cap?: PlacementHostCap | undefined;
}

export interface ThreadPlacementRequest {
  readonly originEnvironmentId: string;
  /** A target the caller named. It wins; the remote path checks it there. */
  readonly pinnedEnvironmentId?: string | undefined;
  /** Workspace, worktree, attachments, referenced context or a dependent parent live here. */
  readonly requiresOrigin?: boolean | undefined;
}

export type ThreadPlacementDecision =
  | {
      readonly accepted: true;
      readonly environmentId: string;
      readonly reason: "pinned" | "local-state" | "capacity";
    }
  | {
      readonly accepted: false;
      readonly reason: "ambiguous-environment" | "conflicting-locality" | "no-eligible-environment";
    };

/**
 * Where a NEW thread runs. Pure: it has no transport effects. A caller binds an accepted
 * remote choice durably before launching, and after an uncertain launch reconciles that
 * binding instead of deciding again, so a retry never lands on another host.
 */
export function chooseThreadPlacement(
  request: ThreadPlacementRequest,
  candidates: ReadonlyArray<ThreadPlacementCandidate>,
  now: number,
): ThreadPlacementDecision {
  const ids = new Set<string>();
  for (const { environmentId } of candidates) {
    if (ids.has(environmentId)) return { accepted: false, reason: "ambiguous-environment" };
    ids.add(environmentId);
  }
  const pinned = request.pinnedEnvironmentId;
  if (request.requiresOrigin === true) {
    if (pinned !== undefined && pinned !== request.originEnvironmentId)
      return { accepted: false, reason: "conflicting-locality" };
    return { accepted: true, environmentId: request.originEnvironmentId, reason: "local-state" };
  }
  if (pinned !== undefined) return { accepted: true, environmentId: pinned, reason: "pinned" };
  const eligible = candidates
    .filter((c) => c.operable && c.projectAvailable && c.modelAvailable)
    .sort((a, b) =>
      a.environmentId < b.environmentId ? -1 : a.environmentId > b.environmentId ? 1 : 0,
    );
  const environmentId = chooseLoadBalancedEnvironment(eligible, now);
  return environmentId === null
    ? { accepted: false, reason: "no-eligible-environment" }
    : { accepted: true, environmentId, reason: "capacity" };
}

export function placementHostLimits(
  hosts: ReadonlyArray<{
    readonly environmentId: string;
    readonly maxLanes: number;
    readonly minAvailableMemoryGiB: number;
  }>,
  environmentId: string,
): { readonly rank?: number; readonly cap?: PlacementHostCap } {
  const rank = hosts.findIndex((host) => host.environmentId === environmentId);
  const host = hosts[rank];
  if (host === undefined) return {};
  return {
    rank,
    cap: { maxLanes: host.maxLanes, minAvailableMemoryBytes: host.minAvailableMemoryGiB * GiB },
  };
}
