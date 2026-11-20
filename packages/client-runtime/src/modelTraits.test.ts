import type { ModelCapabilities, ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  optionsForModelSwitch,
  resolveReasoningEffortForModel,
  statedReasoningEffort,
} from "./modelTraits.ts";

describe("buildTraitsTriggerDisplay", () => {
  it.each([
    { currentValue: undefined, defaultValue: undefined, value: null, label: "Thinking" },
    { currentValue: undefined, defaultValue: "high", value: "high", label: "High" },
    { currentValue: "low", defaultValue: undefined, value: "low", label: "Low" },
    { currentValue: "max", defaultValue: "high", value: "max", label: "Max" },
    { id: "effort", currentValue: undefined, defaultValue: undefined, value: null, label: "" },
  ])("labels Pi thinking without inventing a selection: $label ($value)", (input) => {
    const descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: input.id ?? "thinking",
      label: "Thinking",
      type: "select",
      options: ["low", "high", "max"].map((id) => ({
        id,
        label: id[0]!.toUpperCase() + id.slice(1),
        ...(id === input.defaultValue ? { isDefault: true } : {}),
      })),
      ...(input.currentValue ? { currentValue: input.currentValue } : {}),
    };

    expect(
      buildTraitsTriggerDisplay({
        descriptors: [descriptor],
        primarySelectDescriptorId: descriptor.id,
        ultrathinkPromptControlled: false,
      }).label,
    ).toBe(input.label);
    expect(getDescriptorStringValue(descriptor)).toBe(input.value);
  });
});

function effortCapabilities(input: {
  readonly id?: string;
  readonly values: ReadonlyArray<string>;
  readonly defaultValue?: string;
  readonly promptInjected?: ReadonlyArray<string>;
  readonly extra?: ModelCapabilities["optionDescriptors"];
}): ModelCapabilities {
  return {
    optionDescriptors: [
      {
        id: input.id ?? "effort",
        label: "Effort",
        type: "select",
        options: input.values.map((id) => ({
          id,
          label: id,
          ...(id === input.defaultValue ? { isDefault: true } : {}),
        })),
        ...(input.defaultValue ? { currentValue: input.defaultValue } : {}),
        ...(input.promptInjected ? { promptInjectedValues: [...input.promptInjected] } : {}),
      },
      ...(input.extra ?? []),
    ],
  };
}

describe("resolveReasoningEffortForModel", () => {
  const opus = effortCapabilities({
    values: ["low", "medium", "high", "xhigh"],
    defaultValue: "medium",
  });
  const sonnet = effortCapabilities({ values: ["low", "medium", "high"], defaultValue: "medium" });

  it("keeps an effort the next model offers", () => {
    expect(resolveReasoningEffortForModel("high", sonnet)).toEqual({
      id: "effort",
      value: "high",
      kept: true,
    });
  });

  it("falls back to the next model's default when the effort is not offered", () => {
    expect(resolveReasoningEffortForModel("xhigh", sonnet)).toEqual({
      id: "effort",
      value: "medium",
      kept: false,
    });
    expect(resolveReasoningEffortForModel("xhigh", opus)?.kept).toBe(true);
  });

  it("maps the effort onto the next model's reasoning id", () => {
    const codex = effortCapabilities({
      id: "reasoningEffort",
      values: ["low", "high"],
      defaultValue: "low",
    });
    expect(resolveReasoningEffortForModel("high", codex)).toEqual({
      id: "reasoningEffort",
      value: "high",
      kept: true,
    });
  });

  it("does not keep a prompt-injected level", () => {
    const claude = effortCapabilities({
      values: ["high", "ultrathink"],
      defaultValue: "high",
      promptInjected: ["ultrathink"],
    });
    expect(resolveReasoningEffortForModel("ultrathink", claude)).toEqual({
      id: "effort",
      value: "high",
      kept: false,
    });
  });

  it("returns nothing for a model with no reasoning control", () => {
    expect(
      resolveReasoningEffortForModel("high", {
        optionDescriptors: [
          { id: "fastMode", label: "Fast", type: "boolean", currentValue: false },
        ],
      }),
    ).toBeNull();
  });
});

describe("optionsForModelSwitch", () => {
  const from = effortCapabilities({
    values: ["low", "high", "xhigh"],
    defaultValue: "high",
  });
  const to = effortCapabilities({
    id: "reasoningEffort",
    values: ["low", "medium", "high"],
    defaultValue: "medium",
    extra: [{ id: "fastMode", label: "Fast", type: "boolean" }],
  });

  it("keeps the current effort and supported options, and drops the rest", () => {
    expect(
      optionsForModelSwitch({
        fromOptions: [{ id: "effort", value: "high" }],
        fromCapabilities: from,
        toCapabilities: to,
        baseOptions: [
          { id: "fastMode", value: true },
          { id: "contextWindow", value: "1m" },
          { id: "effort", value: "low" },
        ],
      }),
    ).toEqual([
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value: "high" },
    ]);
  });

  it("leaves the next model's default in place when the effort is not offered", () => {
    expect(
      optionsForModelSwitch({
        fromOptions: [{ id: "effort", value: "xhigh" }],
        fromCapabilities: from,
        toCapabilities: to,
        baseOptions: [
          { id: "fastMode", value: false },
          { id: "reasoningEffort", value: "low" },
        ],
      }),
    ).toEqual([{ id: "fastMode", value: false }]);
    expect(statedReasoningEffort([{ id: "effort", value: "xhigh" }], from)).toBe("xhigh");
  });

  it("keeps an unset effort when that default is offered", () => {
    expect(statedReasoningEffort(undefined, from)).toBe("high");
    expect(
      optionsForModelSwitch({
        fromOptions: undefined,
        fromCapabilities: from,
        toCapabilities: to,
      }),
    ).toEqual([{ id: "reasoningEffort", value: "high" }]);
  });

  it("keeps stored options when the next model has no catalog", () => {
    const stored = [{ id: "reasoningEffort", value: "high" }];
    expect(
      optionsForModelSwitch({
        fromOptions: stored,
        fromCapabilities: null,
        toCapabilities: null,
        baseOptions: stored,
      }),
    ).toEqual(stored);
  });
});
