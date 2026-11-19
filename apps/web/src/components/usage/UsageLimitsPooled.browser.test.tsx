import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

function routedCodex(): ServerProvider {
  return {
    ...managedChatGpt("magpie_codex", "Magpie Codex"),
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: {
        reason: "unsupported",
        message: "Not applicable: this instance routes through a custom model provider.",
      },
    },
  };
}

describe("UsageLimitsPooled quiet states", () => {
  it("shows a stopped machine as one offline line, not its last errors", async () => {
    const failing: ServerProvider = {
      ...managedChatGpt("codex", "Codex"),
      usageLimits: {
        checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed", message: "Codex could not read usage." },
      },
    };
    const presentations = new Map([
      [
        EnvironmentId.make("crown"),
        {
          entry: { target: { label: "Crown Rain Gutters" } },
          connection: { phase: "reconnecting" },
          serverConfig: { providers: [failing] },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect.element(screen.getByText(/offline since/)).toBeVisible();
    expect(screen.container.textContent).not.toContain("could not read usage");
  });

  it("folds not-applicable instances into one closed summary across machines", async () => {
    const presentations = new Map(
      ["primary-r720", "primary-asus", "primary-mac-laptop"].map((label) => [
        EnvironmentId.make(label),
        { entry: { target: { label } }, serverConfig: { providers: [routedCodex()] } },
      ]),
    );
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    const summary = screen.getByText("3 instances have no quota to read");
    await expect.element(summary).toBeVisible();
    const details = screen.container.querySelector("details");
    expect(details?.open).toBe(false);
    await summary.click();
    await expect
      .element(screen.getByText("(primary-r720, primary-asus, primary-mac-laptop)"))
      .toBeVisible();
    expect(screen.container.querySelectorAll("details li")).toHaveLength(1);
  });
});
