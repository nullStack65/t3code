import {
  isProviderAvailable,
  type ModelSelection,
  type ProjectId,
  resolveProjectProviderInstanceEnabled,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { findServedModel } from "../provider/servedModel.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * This environment as a placement candidate: its own load, and whether it runs the exact
 * provider instance and model for the project in the requested mode.
 */
export const hereEvidence = Effect.fn("placement.hereEvidence")(function* (input: {
  readonly projectId: ProjectId;
  readonly modelSelection: Pick<ModelSelection, "instanceId" | "model">;
  readonly runtimeMode: RuntimeMode;
}) {
  const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
  const provider = providers.find(
    (candidate) => candidate.instanceId === input.modelSelection.instanceId,
  );
  const hostResources = yield* Effect.serviceOption(HostResources.HostResources);
  return {
    resources: Option.isSome(hostResources) ? yield* hostResources.value.read : null,
    modelAvailable:
      provider !== undefined &&
      provider.enabled &&
      isProviderAvailable(provider) &&
      resolveProjectProviderInstanceEnabled(settings, input.projectId, provider.instanceId) &&
      findServedModel(provider.models, input.modelSelection.model) !== undefined &&
      (provider.supportedRuntimeModes === undefined ||
        provider.supportedRuntimeModes.length === 0 ||
        provider.supportedRuntimeModes.includes(input.runtimeMode)),
  };
});
