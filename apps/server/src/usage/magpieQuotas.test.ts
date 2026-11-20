import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";

import { codexPlanLabel } from "../provider/CodexProvider.ts";
import {
  codexBaseUrl,
  discoverGatewayOrigins,
  gatewayOrigin,
  isPrivateOrigin,
  magpieQuotasToAccounts,
  makeMagpieApi,
  openCodeBaseUrls,
} from "./magpieQuotas.ts";

const checkedAt = "2026-11-18T22:00:00.000Z";

/** The shapes a Magpie gateway answers with, one per kind of entry it reports. */
const entries = [
  {
    provider: "claude",
    name: "Claude Code",
    kind: "subscription",
    plan: "max",
    user: "first@example.com",
    windows: [
      { name: "5 hours", used: 70, remaining: 30, resetsAt: "2026-11-19T01:40:00Z" },
      { name: "7 days", used: 82, remaining: 18, resetsAt: "2026-11-22T02:00:00Z" },
      { name: "7 days · Fable", used: 57, remaining: 43, resetsAt: "2026-11-22T02:00:00Z" },
    ],
    readAt: "2026-11-18T21:59:00Z",
  },
  {
    provider: "codex",
    name: "Codex",
    kind: "subscription",
    plan: "pro",
    user: "first@example.com",
    windows: [
      { name: "5 hours", used: 12, resetsAt: "2026-11-18T23:00:00Z" },
      { name: "7 days", used: 100, resetsAt: "2026-11-21T17:48:40Z" },
    ],
  },
  {
    provider: "codex",
    name: "Codex",
    kind: "subscription",
    plan: "team",
    user: "first@example.com · Team",
    error: "Payment Required",
  },
  {
    provider: "magpie-go",
    name: "Magpie Go",
    kind: "plan",
    user: "oc-key",
    error:
      "this key has no OpenCode Go subscription: Go belongs to the member who subscribed, in that workspace",
  },
  {
    provider: "magpie-go",
    name: "Magpie Go",
    kind: "plan",
    user: "oc-billed",
    error: "Payment Required",
  },
  {
    provider: "magpie-go",
    name: "Magpie Go",
    kind: "plan",
    user: "oc-other",
    error: "no workspace subscription on this account",
  },
  { provider: "claude", user: "second@example.com", error: "upstream timed out" },
];

describe("magpieQuotasToAccounts", () => {
  const accounts = magpieQuotasToAccounts(entries, checkedAt);

  it("maps every pooled account with windows that line up with the native probes", () => {
    const claude = accounts[0]!;
    expect(claude.driver).toBe("claudeAgent");
    expect(claude.email).toBe("first@example.com");
    expect(claude.plan).toBe("Claude Max");
    expect(claude.usageLimits.windows).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 70,
        windowDurationMins: 300,
        resetsAt: "2026-11-19T01:40:00.000Z",
      },
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 82,
        windowDurationMins: 7 * 24 * 60,
        resetsAt: "2026-11-22T02:00:00.000Z",
      },
      // Same id the Claude probe gives its model-scoped weekly window.
      expect.objectContaining({ id: "seven_day_fable", label: "Weekly · Fable" }),
    ]);
    const codex = accounts[1]!;
    expect(codex.plan).toBe(codexPlanLabel("pro"));
    expect(codex.usageLimits.windows.map((window) => [window.id, window.kind])).toEqual([
      ["primary", "session"],
      ["secondary", "weekly"],
    ]);
  });

  it("drops a Go key with no subscription and keeps payment and failed reads", () => {
    expect(accounts.map((account) => account.id)).toEqual([
      "claude:first@example.com",
      "codex:first@example.com",
      "codex:first@example.com · Team",
      "magpie-go:oc-billed",
      "magpie-go:oc-other",
      "claude:second@example.com",
    ]);
    const team = accounts[2]!;
    const billed = accounts[3]!;
    const other = accounts[4]!;
    const timedOut = accounts[5]!;
    expect(team.email).toBe("first@example.com · Team");
    expect(team.usageLimits.unavailable).toEqual({
      reason: "unsupported",
      message: "Payment Required.",
    });
    expect(billed.driver).toBe("opencode");
    expect(billed.usageLimits.unavailable).toEqual({
      reason: "unsupported",
      message: "Payment Required.",
    });
    expect(other.usageLimits.unavailable).toEqual({
      reason: "unsupported",
      message: "No workspace subscription on this account.",
    });
    expect(timedOut.usageLimits.unavailable?.reason).toBe("probeFailed");
  });
});

describe("gateway discovery", () => {
  it("reads the selected Codex provider's base URL, honouring a launch override", () => {
    const toml = [
      'model_provider = "magpie_asus"',
      "[model_providers.openai]",
      'base_url = "https://api.openai.com/v1"',
      "[model_providers.magpie_asus]",
      'name = "Magpie"',
      'base_url = "http://127.0.0.1:13425/v1"',
      "[model_providers.magpie_asus.auth]",
      'command = "/bin/cat"',
    ].join("\n");
    expect(codexBaseUrl(toml, "")).toBe("http://127.0.0.1:13425/v1");
    expect(codexBaseUrl(toml, "-c model_provider=openai")).toBe("https://api.openai.com/v1");
    expect(codexBaseUrl("model = 'x'", undefined)).toBeUndefined();
    expect(
      codexBaseUrl(
        "model_provider = 'm'\n[model_providers.m]\nbase_url = 'http://127.0.0.1:1/v1'",
        "",
      ),
    ).toBe("http://127.0.0.1:1/v1");
  });

  it("reads OpenCode provider base URLs from JSONC", () => {
    const jsonc = `{
      // comments are allowed
      "provider": {
        "magpie": { "options": { "baseURL": "http://127.0.0.1:3425/v1" } },
        "other": { "options": {} },
      },
    }`;
    expect(openCodeBaseUrls(jsonc)).toEqual(["http://127.0.0.1:3425/v1"]);
    expect(openCodeBaseUrls("not json")).toEqual([]);
  });

  it("only probes hosts the user runs", () => {
    expect(gatewayOrigin("http://127.0.0.1:3425/v1")).toBe("http://127.0.0.1:3425");
    expect(gatewayOrigin("file:///tmp/x")).toBeNull();
    for (const origin of [
      "http://127.0.0.1:3425",
      "http://localhost:3425",
      "http://192.168.0.27:3425",
      "http://100.85.225.50:3425",
      "https://box.tail138dbd.ts.net",
    ]) {
      expect(isPrivateOrigin(origin), origin).toBe(true);
    }
    for (const origin of ["https://api.openai.com", "https://fcm.example.com", "http://8.8.8.8"]) {
      expect(isPrivateOrigin(origin), origin).toBe(false);
    }
  });

  it.effect("collects distinct private gateway origins across enabled instances", () =>
    Effect.gen(function* () {
      const files: Record<string, string> = {
        "/codex-home/config.toml":
          'model_provider = "m"\n[model_providers.m]\nbase_url = "http://127.0.0.1:13425/v1"\n',
        "/home/u/.config/opencode/opencode.jsonc":
          '{ "provider": { "magpie": { "options": { "baseURL": "http://127.0.0.1:13425/v1" } } } }',
        "/claude/settings.json": '{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:3425" } }',
        "/off/config.toml":
          'model_provider = "m"\n[model_providers.m]\nbase_url = "http://127.0.0.1:9999/v1"\n',
      };
      const instance = (driver: string, config: unknown, enabled = true) => ({
        driver: ProviderDriverKind.make(driver),
        enabled,
        config,
      });
      const settings = {
        providerInstances: {
          [ProviderInstanceId.make("codex")]: instance("codex", { homePath: "/codex-home" }),
          [ProviderInstanceId.make("opencode")]: instance("opencode", {}),
          [ProviderInstanceId.make("claude")]: instance("claudeAgent", {
            launchArgs: "--settings /claude/settings.json",
          }),
          [ProviderInstanceId.make("off")]: instance("codex", { homePath: "/off" }, false),
        },
      } as unknown as Pick<ServerSettings, "providerInstances">;
      const origins = yield* discoverGatewayOrigins(settings, { HOME: "/home/u" }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            // A file the fixture lacks reads as empty, as a missing one does.
            readFileString: (path) => Effect.succeed(files[path] ?? ""),
          }),
        ),
        Effect.provide(NodeServices.layer),
      );
      expect(origins).toEqual(["http://127.0.0.1:13425", "http://127.0.0.1:3425"]);
    }),
  );
});

describe("makeMagpieApi", () => {
  const run = (managementKey: string, status = 200) => {
    const seen: Array<{ url: string; authorization: string | undefined }> = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        seen.push({ url: request.url, authorization: request.headers.authorization });
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ object: "list", data: entries.slice(0, 1) }, { status }),
        );
      }),
    );
    return makeMagpieApi.pipe(
      Effect.flatMap((api) => api.readAccounts({ url: "http://127.0.0.1:3425/v1", managementKey })),
      Effect.result,
      Effect.map((result) => ({ result, seen })),
      Effect.provideService(HttpClient.HttpClient, http),
    );
  };

  it.effect("reads the quotas route at the gateway origin, keyless on loopback", () =>
    Effect.gen(function* () {
      const { result, seen } = yield* run("");
      expect(seen).toEqual([
        { url: "http://127.0.0.1:3425/v1/magpie/quotas", authorization: undefined },
      ]);
      expect(result._tag === "Success" && result.success.map((account) => account.id)).toEqual([
        "claude:first@example.com",
      ]);
    }),
  );

  it.effect("gives up on a gateway whose body never finishes", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(new ReadableStream({ start() {} }), {
              headers: { "content-type": "application/json" },
            }),
          ),
        ),
      );
      const fiber = yield* makeMagpieApi.pipe(
        Effect.flatMap((api) =>
          api.readAccounts({ url: "http://127.0.0.1:3425", managementKey: "" }),
        ),
        Effect.result,
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.forkChild,
      );
      yield* TestClock.adjust("5 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result._tag === "Failure" && result.failure.detail).toMatch(/did not answer/);
    }),
  );

  it.effect("sends a configured gateway key and explains a refusal", () =>
    Effect.gen(function* () {
      const { result, seen } = yield* run("gateway-key", 401);
      expect(seen[0]!.authorization).toBe("Bearer gateway-key");
      expect(result._tag === "Failure" && result.failure.detail).toMatch(/refused the key/);
    }),
  );
});
