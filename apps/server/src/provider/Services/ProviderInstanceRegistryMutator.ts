/**
 * ProviderInstanceRegistryMutator — internal handle used by the hydration
 * layer to reconcile the live registry with a fresh
 * `ProviderInstanceConfigMap`.
 *
 * Kept separate from the public `ProviderInstanceRegistry` service tag so
 * downstream consumers (drivers, reactors, `ProviderService`) can only read
 * from the registry. Only the hydration layer — which watches
 * `ServerSettingsService.streamChanges` and applies diffs — imports this
 * tag.
 *
 * The mutator exposes a single entry point, `reconcile(configMap, identity)`,
 * which:
 *
 *   1. Diffs the incoming map against the live one keyed by instance id.
 *   2. Closes the per-instance `Scope` of every removed or replaced entry
 *      (tearing down adapter processes, refresh fibres, temp files) BEFORE
 *      creating the replacement — `reconcile` guarantees "at most one live
 *      instance per id" at all times. An entry is replaced when its envelope
 *      changes or its `identity` string changes; the identity covers host
 *      policy that changes how a driver builds the instance without appearing
 *      in the driver's config blob.
 *   3. Opens a fresh child `Scope` for every added or replaced entry, runs
 *      the driver's `create`, and stores the resulting `ProviderInstance`
 *      plus its scope.
 *   4. Publishes one `void` tick on the registry's `streamChanges` PubSub at
 *      the end of the batch — consumers re-pull `listInstances` /
 *      `listUnavailable`.
 *
 * `reconcile` is idempotent: calling it with an unchanged config map is a
 * no-op (no scope churn, no pubsub emission).
 *
 * @module provider/Services/ProviderInstanceRegistryMutator
 */
import type { ProviderInstanceConfigMap, ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProviderInstanceRegistryMutatorShape {
  /**
   * Bring the live registry in line with the supplied config map. See
   * module docs for the add / remove / replace semantics.
   *
   * The effect never fails: individual driver `create` failures are
   * captured as "unavailable" shadow snapshots inside the registry, the
   * same way boot-time failures are handled by
   * `makeProviderInstanceRegistry`. This keeps settings-watcher loops from
   * erroring out on a single bad entry.
   */
  readonly reconcile: (
    configMap: ProviderInstanceConfigMap,
    /**
     * Construction identity per instance id, for policy that gates how a
     * driver builds its instance but is not part of `config`. A changed
     * identity replaces that instance, retiring its previous readers before
     * the replacement is published. Omitted ids keep the empty identity.
     */
    identity?: ReadonlyMap<ProviderInstanceId, string>,
  ) => Effect.Effect<void>;
}

export class ProviderInstanceRegistryMutator extends Context.Service<
  ProviderInstanceRegistryMutator,
  ProviderInstanceRegistryMutatorShape
>()("t3/provider/Services/ProviderInstanceRegistryMutator") {}
