import type { HostResourcesSnapshot } from "@t3tools/contracts";
import { chooseLoadBalancedEnvironment } from "./loadBalancing.ts";

/** Evidence must come from the authenticated native destination/link registry.
 * Caller-supplied labels are not evidence. This function has no transport effects.
 */
export interface ThreadPlacementCandidate {
  readonly environmentId: string;
  readonly resources: HostResourcesSnapshot | null;
  readonly receivedAt: number;
  readonly weight: number;
  readonly online: boolean;
  readonly protocolCompatible: boolean;
  readonly operateGranted: boolean;
  readonly audienceGranted: boolean;
  readonly runtimeModeGranted: boolean;
  readonly projectAvailable: boolean;
  readonly providerAvailable: boolean;
  readonly modelAvailable: boolean;
  readonly hostedToolsAvailable: boolean;
  readonly contextCompatible: boolean;
}
export interface ThreadPlacementRequest {
  readonly originEnvironmentId: string;
  readonly pinnedEnvironmentId?: string;
  readonly existingThreadEnvironmentId?: string;
  readonly requiresLocalState: boolean;
  readonly parentEnvironmentId?: string;
  readonly independentTask?: boolean;
  readonly requiresHostedTools?: boolean;
}
export type ThreadPlacementDecision =
  | {
      readonly accepted: true;
      readonly environmentId: string;
      readonly reason: "existing" | "pinned" | "locality" | "capacity";
    }
  | {
      readonly accepted: false;
      readonly reason: "no-eligible-environment" | "conflicting-locality" | "ambiguous-environment";
    };

/** Native launch admission must call this for each NEW execution and bind the
 * accepted identity to its durable request receipt before executing remotely.
 * A timeout is not a rejection: reconcile that receipt, never select a new host.
 */
export function chooseThreadPlacement(
  request: ThreadPlacementRequest,
  candidates: ReadonlyArray<ThreadPlacementCandidate>,
  now: number,
): ThreadPlacementDecision {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.environmentId))
      return { accepted: false, reason: "ambiguous-environment" };
    ids.add(candidate.environmentId);
  }
  const pinned = request.existingThreadEnvironmentId ?? request.pinnedEnvironmentId;
  const parentLocality =
    request.parentEnvironmentId && request.independentTask !== true
      ? request.parentEnvironmentId
      : undefined;
  if (
    request.requiresLocalState &&
    parentLocality &&
    parentLocality !== request.originEnvironmentId
  ) {
    return { accepted: false, reason: "conflicting-locality" };
  }
  const locality = request.requiresLocalState ? request.originEnvironmentId : parentLocality;
  if (
    (request.existingThreadEnvironmentId &&
      request.pinnedEnvironmentId &&
      request.existingThreadEnvironmentId !== request.pinnedEnvironmentId) ||
    (locality && pinned && pinned !== locality)
  ) {
    return { accepted: false, reason: "conflicting-locality" };
  }
  const target = pinned ?? locality;
  const eligible = candidates
    .filter(
      (candidate) =>
        candidate.online &&
        candidate.protocolCompatible &&
        candidate.operateGranted &&
        candidate.audienceGranted &&
        candidate.runtimeModeGranted &&
        candidate.projectAvailable &&
        candidate.providerAvailable &&
        candidate.modelAvailable &&
        (!request.requiresHostedTools || candidate.hostedToolsAvailable) &&
        candidate.contextCompatible &&
        (target === undefined || target === candidate.environmentId),
    )
    .toSorted((a, b) =>
      a.environmentId < b.environmentId ? -1 : a.environmentId > b.environmentId ? 1 : 0,
    );
  const environmentId = chooseLoadBalancedEnvironment(eligible, now);
  if (environmentId === null) return { accepted: false, reason: "no-eligible-environment" };
  return {
    accepted: true,
    environmentId,
    reason: request.existingThreadEnvironmentId
      ? "existing"
      : request.pinnedEnvironmentId
        ? "pinned"
        : locality !== undefined
          ? "locality"
          : "capacity",
  };
}
