import { assert, describe, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";

import { parseMagpieGatewayCatalog, withMagpieGatewayModels } from "./MagpieGatewayModels.ts";

const efforts = (...levels: ReadonlyArray<string>) => levels.map((effort) => ({ effort }));

// Trimmed from a live Magpie `/v1/models` response.
const MAGPIE_CATALOG = {
  object: "list",
  data: [
    {
      id: "group/auto-gpt-5-6-luna",
      display_name: "GPT-5.6 Luna",
      magpie_label: "GPT-5.6 Luna · routing group",
      owned_by: "magpie-go",
      supported_reasoning_levels: efforts("low", "high"),
    },
    {
      id: "magpie-go/gpt-5.6-luna",
      display_name: "GPT-5.6 Luna",
      magpie_label: "GPT-5.6 Luna · Magpie Go",
      owned_by: "magpie-go",
      supported_reasoning_levels: efforts("none", "low", "max"),
    },
    {
      id: "magpie-go/mimo-v2.6-pro",
      display_name: "MiMo-V2.6-Pro",
      magpie_label: "MiMo-V2.6-Pro · Magpie Go",
      owned_by: "magpie-go",
      supported_reasoning_levels: [],
    },
    {
      id: "claude/claude-opus-5-5",
      display_name: "Claude Opus 5.5",
      magpie_label: "Claude Opus 5.5 · Claude Code",
      owned_by: "claude",
    },
    {
      id: "claude/claude-haiku-4-5-20251001",
      display_name: "Claude Haiku 4.5",
      magpie_label: "Claude Haiku 4.5 · Claude Code",
      owned_by: "claude",
    },
    {
      id: "claude/claude-sonnet-4-5",
      display_name: "Claude Sonnet 4.5 (latest)",
      magpie_label: "Claude Sonnet 4.5 (latest) · Claude Code",
      owned_by: "claude",
      supported_reasoning_levels: efforts("low", "high"),
    },
    {
      id: "claude/claude-sonnet-4-5-20250929",
      display_name: "Claude Sonnet 4.5",
      magpie_label: "Claude Sonnet 4.5 · Claude Code",
      owned_by: "claude",
    },
    {
      id: "codex/gpt-6-luna",
      display_name: "GPT-6-Luna",
      magpie_label: "GPT-6-Luna · Codex",
      owned_by: "codex",
      supported_reasoning_levels: efforts("medium"),
    },
  ],
};

const builtIn = (slug: string, aliases: ReadonlyArray<string> = []): ServerProviderModel => ({
  slug,
  name: slug,
  aliases: [...aliases],
  isCustom: false,
  capabilities: {
    optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
  },
});

describe("parseMagpieGatewayCatalog", () => {
  it("recognises Magpie only by its labelled entries", () => {
    assert.strictEqual(parseMagpieGatewayCatalog(MAGPIE_CATALOG)?.length, 8);
    // A plain Anthropic-compatible gateway lists models without Magpie's labels.
    assert.strictEqual(
      parseMagpieGatewayCatalog({ data: [{ id: "claude-opus-5-5", display_name: "Opus" }] }),
      undefined,
    );
    assert.strictEqual(parseMagpieGatewayCatalog({ error: "nope" }), undefined);
  });
});

describe("withMagpieGatewayModels", () => {
  const gateway = parseMagpieGatewayCatalog(MAGPIE_CATALOG) ?? [];
  const custom: ServerProviderModel = {
    slug: "codex/gpt-6-luna",
    name: "My Luna",
    isCustom: true,
    capabilities: null,
  };
  const models = withMagpieGatewayModels(
    [
      builtIn("claude-opus-5-5", ["opus"]),
      builtIn("claude-haiku-4-5", ["claude-haiku-4-5-20251001"]),
      builtIn("claude-fable-5-2"),
      custom,
    ],
    gateway,
  );

  it("keeps served built-in Claude models first, then groups the rest by route", () => {
    assert.deepStrictEqual(
      models.map((model) => [model.slug, model.subProvider ?? null]),
      [
        ["claude-opus-5-5", null],
        ["claude-haiku-4-5", null],
        // One entry per Claude model: the dated duplicate is dropped.
        ["claude/claude-sonnet-4-5", "Claude Code"],
        ["magpie-go/gpt-5.6-luna", "Magpie Go · 200K context"],
        ["magpie-go/mimo-v2.6-pro", "Magpie Go · 200K context"],
        ["group/auto-gpt-5-6-luna", "Routing group · 200K context"],
        // A custom model of the same slug wins over the gateway entry.
        ["codex/gpt-6-luna", null],
      ],
    );
    // The gateway does not serve Fable 5.2, so it is not offered.
    assert.isFalse(models.some((model) => model.slug === "claude-fable-5-2"));
    assert.strictEqual(models[0]?.capabilities?.optionDescriptors?.[0]?.id, "fastMode");
  });

  it("offers only the effort levels Claude Code can send", () => {
    const effortChoices = (slug: string) => {
      const descriptor = models
        .find((model) => model.slug === slug)
        ?.capabilities?.optionDescriptors?.find((option) => option.id === "effort");
      return descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [];
    };
    assert.deepStrictEqual(effortChoices("magpie-go/gpt-5.6-luna"), ["default", "low", "max"]);
    assert.deepStrictEqual(effortChoices("magpie-go/mimo-v2.6-pro"), []);
  });
});
