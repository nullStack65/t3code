import type {
  ModelCapabilities,
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
} from "@t3tools/shared/model";
import { REASONING_EFFORT_OPTION_IDS } from "./state/threadExecution.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const REASONING_DESCRIPTOR_IDS: ReadonlySet<string> = new Set([
  ...REASONING_EFFORT_OPTION_IDS,
  "thinking",
]);

/** The model's reasoning control: a known effort id, or a select its agent marked as reasoning. */
export function isReasoningControl(descriptor: ProviderOptionDescriptor): boolean {
  return (
    (descriptor.type === "select" && descriptor.role === "reasoning") ||
    REASONING_DESCRIPTOR_IDS.has(descriptor.id)
  );
}

export function isReasoningSelect(
  descriptor: ProviderOptionDescriptor,
): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> {
  return descriptor.type === "select" && isReasoningControl(descriptor);
}

export function replaceDescriptorCurrentValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.map((descriptor) =>
    descriptor.id !== descriptorId
      ? descriptor
      : descriptor.type === "boolean"
        ? {
            ...descriptor,
            ...(typeof currentValue === "boolean" ? { currentValue } : {}),
          }
        : {
            ...descriptor,
            ...(typeof currentValue === "string" ? { currentValue } : {}),
          },
  );
}

export function getDescriptorStringValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null,
  selection?: ModelSelection | null,
  reportedSelection?: ModelSelection | null,
): string | null {
  if (!descriptor) {
    return null;
  }
  const value = getProviderOptionCurrentValue(descriptor, selection, reportedSelection);
  return typeof value === "string" ? value : null;
}

// Prompt-injected levels such as Ultrathink still work when typed, but pickers do not offer them.
export function selectableProviderOptionChoices(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
) {
  return descriptor.options.filter(
    (option) => !descriptor.promptInjectedValues?.includes(option.id),
  );
}

export function getPromptControlledTraits(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  prompt: string,
  allowPromptInjectedEffort = true,
) {
  const primarySelectDescriptor =
    descriptors.find((descriptor) => descriptor.type === "select") ?? null;
  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);
  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));
  return { primarySelectDescriptor, ultrathinkPromptControlled, ultrathinkInBodyText };
}

export function getTraitSelectChange(
  selected: ReturnType<typeof getPromptControlledTraits> & {
    descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  },
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  prompt: string,
  value: string,
) {
  if (!value || descriptor.promptInjectedValues?.includes(value)) return null;
  const isPrimary = descriptor.id === selected.primarySelectDescriptor?.id;
  if (isPrimary && selected.ultrathinkInBodyText) return null;
  return {
    prompt:
      isPrimary && selected.ultrathinkPromptControlled
        ? prompt.replace(/^Ultrathink:\s*/i, "")
        : prompt,
    modelOptions: buildProviderOptionSelectionsFromDescriptors(
      replaceDescriptorCurrentValue(selected.descriptors, descriptor.id, value),
    ),
  };
}

export function buildTraitsTriggerDisplay(
  input: {
    descriptors: ReadonlyArray<ProviderOptionDescriptor>;
    primarySelectDescriptorId: string | null;
    ultrathinkPromptControlled: boolean;
    modelSelection?: ModelSelection | null;
    reportedModelSelection?: ModelSelection | null | undefined;
  },
  resolve: MFunctionType = mFallback,
): {
  label: string;
  /** "Fast" or "Ultrafast" when a speed option is on. */
  speedLabel: string | null;
  ultracode: boolean;
} {
  let fastModeFallbackLabel: string | null = null;
  let speedLabel: string | null = null;
  let reasoningLabelIndex = -1;
  let ultracodeLabelIndex = -1;
  const labels: Array<string> = [];
  for (const descriptor of input.descriptors) {
    if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      speedLabel = descriptor.currentValue === true ? "Fast" : null;
      fastModeFallbackLabel =
        speedLabel ?? resolve(msg("Normal", { $context: "model speed tier" }));
      continue;
    }
    if (descriptor.id === "ultracode" && descriptor.type === "boolean") {
      if (descriptor.currentValue === true) {
        ultracodeLabelIndex = labels.length;
        labels.push(descriptor.label);
      }
      continue;
    }
    if (descriptor.id === "serviceTier" && descriptor.type === "select") {
      const currentValue = getProviderOptionCurrentValue(descriptor);
      const fastTier = descriptor.options.find(({ label }) => label === "Fast");
      const ultrafastTier = descriptor.options.find(({ label }) => label === "Ultrafast");
      if (
        ((fastTier || ultrafastTier) && currentValue === "default") ||
        (fastTier && currentValue === fastTier.id) ||
        (ultrafastTier && currentValue === ultrafastTier.id)
      ) {
        speedLabel =
          ultrafastTier && currentValue === ultrafastTier.id
            ? "Ultrafast"
            : fastTier && currentValue === fastTier.id
              ? "Fast"
              : null;
        fastModeFallbackLabel =
          descriptor.options.find(({ id }) => id === currentValue)?.label ??
          resolve(msg("Normal", { $context: "model speed tier" }));
        continue;
      }
    }
    const label =
      input.ultrathinkPromptControlled && descriptor.id === input.primarySelectDescriptorId
        ? "Ultrathink"
        : descriptor.type === "boolean"
          ? descriptor.currentValue === true
            ? resolve(msg("{label} On", { label: descriptor.label }))
            : resolve(msg("{label} Off", { label: descriptor.label }))
          : (getProviderOptionCurrentLabel(
              descriptor,
              input.modelSelection,
              input.reportedModelSelection,
            ) ?? (descriptor.id === "thinking" ? descriptor.label : null));
    if (typeof label === "string" && label.length > 0) {
      if (reasoningLabelIndex === -1 && isReasoningSelect(descriptor)) {
        reasoningLabelIndex = labels.length;
      }
      labels.push(label);
    }
  }

  const ultracode = ultracodeLabelIndex >= 0;
  if (labels.length === 0 && fastModeFallbackLabel !== null) {
    return { label: fastModeFallbackLabel, speedLabel, ultracode };
  }
  if (speedLabel) {
    if (reasoningLabelIndex >= 0) {
      labels[reasoningLabelIndex] = `${labels[reasoningLabelIndex]} ${speedLabel}`;
    } else {
      labels.push(speedLabel);
    }
  }
  return { label: labels.join(" · "), speedLabel, ultracode };
}

function reasoningDescriptor(
  capabilities: ModelCapabilities | null | undefined,
): Extract<ProviderOptionDescriptor, { type: "select" }> | null {
  return capabilities?.optionDescriptors?.find(isReasoningSelect) ?? null;
}

function explicitReasoningValue(
  options: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): string | null {
  if (!options) return null;
  for (const id of REASONING_DESCRIPTOR_IDS) {
    const value = options.find(
      (option) => option.id === id && typeof option.value === "string",
    )?.value;
    if (typeof value === "string") return value;
  }
  return null;
}

export function statedReasoningEffort(
  options: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  capabilities: ModelCapabilities | null | undefined,
): string | null {
  const descriptor = reasoningDescriptor(capabilities);
  if (!descriptor || !capabilities?.optionDescriptors?.length) {
    return explicitReasoningValue(options);
  }
  const resolved = getProviderOptionDescriptors({
    caps: capabilities,
    selections: options,
  }).find((candidate) => candidate.id === descriptor.id);
  if (!resolved || resolved.type !== "select") return explicitReasoningValue(options);
  const value = getProviderOptionCurrentValue(resolved);
  return typeof value === "string" ? value : null;
}

export function resolveReasoningEffortForModel(
  effort: string | null,
  capabilities: ModelCapabilities | null | undefined,
): { readonly id: string; readonly value: string; readonly kept: boolean } | null {
  const descriptor = reasoningDescriptor(capabilities);
  if (!descriptor) return null;
  const choices = selectableProviderOptionChoices(descriptor);
  if (effort && choices.some((choice) => choice.id === effort)) {
    return { id: descriptor.id, value: effort, kept: true };
  }
  const fallback =
    choices.find((choice) => choice.isDefault)?.id ??
    (descriptor.currentValue && choices.some((choice) => choice.id === descriptor.currentValue)
      ? descriptor.currentValue
      : undefined);
  if (!fallback) return null;
  return { id: descriptor.id, value: fallback, kept: false };
}

function isCarriedReasoningOption(
  id: string,
  capabilities: ModelCapabilities | null | undefined,
): boolean {
  const descriptor = capabilities?.optionDescriptors?.find((candidate) => candidate.id === id);
  if (!descriptor) return REASONING_DESCRIPTOR_IDS.has(id);
  return isReasoningSelect(descriptor);
}

export function optionsForModelSwitch(input: {
  readonly fromOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly fromCapabilities: ModelCapabilities | null | undefined;
  readonly toCapabilities: ModelCapabilities | null | undefined;
  readonly baseOptions?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionSelection> | undefined {
  const descriptors = input.toCapabilities?.optionDescriptors;
  if (!descriptors || descriptors.length === 0) {
    return input.baseOptions && input.baseOptions.length > 0 ? [...input.baseOptions] : undefined;
  }
  const next: Array<ProviderOptionSelection> = [];
  for (const option of input.baseOptions ?? []) {
    if (isCarriedReasoningOption(option.id, input.toCapabilities)) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    if (!descriptor) continue;
    if (descriptor.type === "boolean") {
      if (typeof option.value === "boolean") next.push({ id: option.id, value: option.value });
      continue;
    }
    if (typeof option.value !== "string") continue;
    if (descriptor.promptInjectedValues?.includes(option.value)) continue;
    if (!descriptor.options.some((choice) => choice.id === option.value)) continue;
    next.push({ id: option.id, value: option.value });
  }
  const resolved = resolveReasoningEffortForModel(
    statedReasoningEffort(input.fromOptions, input.fromCapabilities),
    input.toCapabilities,
  );
  if (resolved?.kept) next.push({ id: resolved.id, value: resolved.value });
  return next.length > 0 ? next : undefined;
}
