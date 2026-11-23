import type { EnvironmentId, UsageModelFilter, UsageSummaryInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { AtomRegistry } from "effect/reactivity";

import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { createEnvironmentPresentationAtoms } from "./presentation.ts";
import { executeAtomQuery, runAtomCommand, squashAtomCommandFailure } from "./runtime.ts";
import type { createServerEnvironmentAtoms } from "./server.ts";

const isEnvironmentRpcUnavailable = Schema.is(EnvironmentRpcUnavailableError);

/** The Usage tab asks each environment with that environment's configured model filter. */
export function usageSummaryInput(
  input: UsageSummaryInput,
  modelFilter: UsageModelFilter | undefined,
): UsageSummaryInput {
  return modelFilter === undefined ? input : { ...input, modelFilter };
}

const limitsRefreshAfter = new Map<EnvironmentId, number>();
/** In-flight limits refresh. `live` is a manual reread; automatic refreshes share or skip it. */
const limitsRefreshes = new Map<
  EnvironmentId,
  { readonly live: boolean; readonly promise: Promise<unknown> }
>();

function beginLimitsRefresh<A>(
  environmentId: EnvironmentId,
  refresh: () => Promise<A>,
  live: boolean,
): Promise<A> {
  const current = Promise.resolve()
    .then(refresh)
    .finally(() => {
      if (limitsRefreshes.get(environmentId)?.promise === current) {
        limitsRefreshes.delete(environmentId);
      }
      // @effect-diagnostics-next-line globalDate:off
      limitsRefreshAfter.set(environmentId, Date.now() + 5 * 60_000);
    });
  limitsRefreshes.set(environmentId, { live, promise: current });
  return current;
}

export async function refreshUsageLimits<A>(
  environmentId: EnvironmentId,
  refresh: () => Promise<A>,
  automatic = false,
): Promise<A | undefined> {
  const pending = limitsRefreshes.get(environmentId);
  if (automatic) {
    if (pending !== undefined) return;
    // @effect-diagnostics-next-line globalDate:off
    if (Date.now() < (limitsRefreshAfter.get(environmentId) ?? 0)) return;
    return await beginLimitsRefresh(environmentId, refresh, false);
  }
  // A click during an automatic poll waits, then rereads. It does not keep that poll's result.
  if (pending?.live) return (await pending.promise) as A;
  if (pending) {
    await pending.promise.catch(() => undefined);
    const started = limitsRefreshes.get(environmentId);
    if (started?.live) return (await started.promise) as A;
  }
  return await beginLimitsRefresh(environmentId, refresh, true);
}

export async function refreshUsage({
  registry,
  server,
  presentations,
  environmentIds,
  input,
}: {
  registry: AtomRegistry.AtomRegistry;
  server: Pick<
    ReturnType<typeof createServerEnvironmentAtoms>,
    "usageSummary" | "refreshUsageRates" | "usageModelFilterAtom"
  >;
  presentations: Pick<ReturnType<typeof createEnvironmentPresentationAtoms>, "presentationAtom">;
  environmentIds: readonly EnvironmentId[];
  input: UsageSummaryInput;
}): Promise<void> {
  await Promise.all(
    environmentIds.map(async (environmentId) => {
      const query = server.usageSummary({
        environmentId,
        input: usageSummaryInput(input, registry.get(server.usageModelFilterAtom(environmentId))),
      });
      const presentation = presentations.presentationAtom(environmentId);
      const controller = new AbortController();
      const abortWhenDisconnected = () => {
        if (registry.get(presentation)?.connection.phase !== "connected") controller.abort();
      };
      const unsubscribe = registry.subscribe(presentation, abortWhenDisconnected);
      abortWhenDisconnected();
      try {
        const ratesResult = await runAtomCommand(
          registry,
          server.refreshUsageRates,
          { environmentId, input: {} },
          { reportFailure: false },
        );
        const sessionUnavailable =
          ratesResult._tag === "Failure" &&
          isEnvironmentRpcUnavailable(squashAtomCommandFailure(ratesResult));
        registry.refresh(query);
        if (sessionUnavailable || controller.signal.aborted) return;
        await executeAtomQuery(registry, query, {
          reportFailure: false,
          signal: controller.signal,
        });
      } finally {
        unsubscribe();
      }
    }),
  );
}
