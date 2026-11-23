import {
  type ModelSelection,
  type OrchestrationV2Command,
  OrchestrationV2ProviderFailoverRefused,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  orchestrationV2RunFailure,
  resolveProjectProviderInstanceEnabled,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";

type FailoverRequest = NonNullable<
  Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>["providerFailover"]
>;
type Refusal = ConstructorParameters<typeof OrchestrationV2ProviderFailoverRefused>[0];

/**
 * Items a turn records without acting on anything outside the conversation. Any other item, a
 * command, file change, tool call, search, approval or subagent, may have had an effect, so
 * replaying the prompt elsewhere could repeat it.
 */
const EFFECT_FREE_ITEM_TYPES: ReadonlySet<string> = new Set([
  "user_message",
  "assistant_message",
  "reasoning",
  "error",
  "system_notice",
  "run",
  "node",
  "provider_thread",
  "checkpoint",
  "compaction",
  "handoff",
  "notification",
  "thread_created",
]);

// The orchestrator's own workspace setup row, recorded before any provider turn; see Orchestrator.ts.
const WORKSPACE_PREPARATION_INPUT = "Preparing workspace";

const mayHaveActed = (item: OrchestrationV2TurnItem) =>
  !EFFECT_FREE_ITEM_TYPES.has(item.type) &&
  !(
    item.type === "command_execution" &&
    item.providerTurnId === null &&
    item.input === WORKSPACE_PREPARATION_INPUT
  );

const selectionKey = (selection: Pick<ModelSelection, "instanceId" | "model">) =>
  `${selection.instanceId}\u0000${selection.model}`;

export type ProviderFailoverAdmission =
  | { readonly type: "admitted"; readonly target: ModelSelection }
  | { readonly type: "duplicate" }
  | { readonly type: "refused"; readonly refusal: OrchestrationV2ProviderFailoverRefused };

/**
 * Admits a failed run's continuation on another provider only when replaying its prompt there
 * repeats nothing: a payment, rate-limit, auth or quota failure on the thread's latest run, no
 * open request, and no item that may have acted. The target is the first candidate that is
 * included, enabled here and not yet tried in the run's lineage.
 */
export function admitProviderFailover(
  request: FailoverRequest,
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "runtimeRequests">,
  /** Every turn item of the failed run, of all types. */
  sourceTurnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  settings: Pick<
    ServerSettings,
    "providerFailover" | "providerInstances" | "projectSettingsOverrides"
  >,
): ProviderFailoverAdmission {
  // A run continues once; a repeated request accepts without starting another.
  if (projection.runs.some((run) => run.providerFailoverOfRunId === request.ofRunId)) {
    return { type: "duplicate" };
  }
  const source = projection.runs.find((run) => run.id === request.ofRunId);
  const providerFailure =
    source === undefined ? null : latestRootProviderFailure(source, sourceTurnItems);
  const failure =
    source === undefined || providerFailure === null
      ? null
      : orchestrationV2RunFailure(source, providerFailure);
  const refuse = (
    reason: Refusal["reason"],
    candidates: Refusal["candidates"] = [],
  ): ProviderFailoverAdmission => ({
    type: "refused",
    refusal: new OrchestrationV2ProviderFailoverRefused({
      runId: request.ofRunId,
      reason,
      failure,
      candidates,
    }),
  });
  if (!settings.providerFailover.enabled) return refuse("disabled");
  if (
    source === undefined ||
    source.status !== "failed" ||
    latestExecutedRun(projection.runs)?.id !== source.id ||
    projection.thread.archivedAt !== null ||
    projection.thread.deletedAt !== null
  ) {
    return refuse("not_latest_failed_run");
  }
  if (failure === null || failure.class === "other") return refuse("not_failover_class");
  if (projection.runtimeRequests.some((runtimeRequest) => runtimeRequest.status === "pending")) {
    return refuse("pending_request");
  }
  if (sourceTurnItems.some((item) => item.runId === source.id && mayHaveActed(item))) {
    return refuse("side_effects");
  }

  const runs = new Map(projection.runs.map((run) => [run.id, run]));
  const tried = new Set<string>();
  let hops = 0;
  for (
    let current: OrchestrationV2Run | undefined = source;
    current !== undefined && !tried.has(selectionKey(current.modelSelection));
    current =
      current.providerFailoverOfRunId === undefined
        ? undefined
        : runs.get(current.providerFailoverOfRunId)
  ) {
    tried.add(selectionKey(current.modelSelection));
    if (current.providerFailoverOfRunId !== undefined) hops += 1;
  }
  if (hops >= settings.providerFailover.maxAttempts) return refuse("exhausted");

  const included = new Set(settings.providerFailover.includedProviderInstanceIds);
  const skipped: Array<Refusal["candidates"][number]> = [];
  for (const candidate of request.candidates) {
    const skip = tried.has(selectionKey(candidate))
      ? "already_tried"
      : !included.has(candidate.instanceId)
        ? "not_included"
        : !Object.hasOwn(settings.providerInstances, candidate.instanceId) ||
            !resolveProjectProviderInstanceEnabled(
              settings,
              projection.thread.projectId,
              candidate.instanceId,
            )
          ? "unavailable"
          : null;
    if (skip === null) return { type: "admitted", target: candidate };
    skipped.push({
      providerInstanceId: candidate.instanceId,
      model: candidate.model,
      skipped: skip,
    });
  }
  return refuse("exhausted", skipped);
}
