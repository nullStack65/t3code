import {
  isProviderAvailable,
  type ModelSelection,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

export function providerReadinessConstraints(provider: ServerProvider): string[] {
  const constraints: string[] = [];
  if (!isProviderAvailable(provider)) {
    constraints.push(provider.unavailableReason ?? "Provider driver is unavailable.");
  }
  if (!provider.enabled) {
    constraints.push("Provider instance is disabled.");
    // Disabled snapshots contain placeholders for installation, health, and auth.
    return constraints;
  }
  if (!provider.installed) constraints.push("Provider executable is not installed.");
  if (provider.status === "error" || provider.status === "disabled") {
    constraints.push(provider.message ?? `Provider status is ${provider.status}.`);
  }
  if (provider.auth.status === "unauthenticated") {
    constraints.push("Provider is not authenticated.");
  }
  if (provider.models.length === 0) constraints.push("No models available.");
  return constraints;
}

const LISTED_MODEL_LIMIT = 8;

type ListedModel = Pick<ServerProviderModel, "slug" | "aliases" | "isLegacy" | "isCustom">;

export function findServedModel<Model extends Pick<ServerProviderModel, "slug" | "aliases">>(
  models: ReadonlyArray<Model>,
  model: string,
): Model | undefined {
  return (
    models.find((candidate) => candidate.slug === model) ??
    models.find((candidate) =>
      candidate.aliases?.some((alias) => alias.toLowerCase() === model.toLowerCase()),
    )
  );
}

function servedModelsHint(models: ReadonlyArray<ListedModel>, requested: string): string {
  const lastSegment = (slug: string) => slug.slice(slug.lastIndexOf("/") + 1).toLowerCase();
  const wanted = lastSegment(requested);
  const close = models.filter((model) => lastSegment(model.slug) === wanted);
  if (close.length > 0) {
    return `Did you mean ${close
      .slice(0, LISTED_MODEL_LIMIT)
      .map((model) => model.slug)
      .join(", ")}?`;
  }
  const listed = models
    .toSorted((a, b) => Number(a.isLegacy ?? false) - Number(b.isLegacy ?? false))
    .slice(0, LISTED_MODEL_LIMIT);
  const omitted = models.length - listed.length;
  return `Advertised models: ${listed.map((model) => model.slug).join(", ")}${
    omitted > 0 ? ` and ${omitted} more; orchestrator_capabilities with search finds them` : ""
  }.`;
}

export function unservedModelMessage(
  instanceId: string,
  model: string,
  models: ReadonlyArray<ListedModel>,
): string | undefined {
  if (
    models.every((candidate) => candidate.isCustom) ||
    findServedModel(models, model) !== undefined
  )
    return undefined;
  return `Model ${model} is not advertised by provider ${instanceId}. ${servedModelsHint(models, model)}`;
}

export function refuseUnservedModel(
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "models">>,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): string | undefined {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (provider === undefined) return undefined;
  return unservedModelMessage(provider.instanceId, selection.model, provider.models);
}

export function modelSelectionFromCommand(
  command: OrchestrationV2ServerCommand,
): ModelSelection | undefined {
  switch (command.type) {
    case "thread.create":
    case "thread.model-selection.set":
    case "provider.switch":
    case "delegated_task.request":
      return command.modelSelection;
    case "message.dispatch":
      return command.modelSelection;
    default:
      return undefined;
  }
}
