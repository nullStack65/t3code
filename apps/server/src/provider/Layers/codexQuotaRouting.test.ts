import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  CodexSettings,
  ProviderInstanceId,
  ProviderDriverKind,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";
import * as Schema from "effect/Schema";

import { withInstanceIdentity } from "../Drivers/instanceIdentity.ts";
import { checkCodexProviderStatus, makePendingCodexProvider } from "./CodexProvider.ts";
import { readOpenCodeGoUsageLimits } from "./openCodeUsageLimits.ts";
import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "../providerUsageLimits.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeMethod = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String));
const decodeSettings = Schema.decodeUnknownEffect(CodexSettings);
const windowsHost = HostProcessPlatform.defaultValue() === "win32";
const chatgpt = { type: "chatgpt", email: "synthetic@example.test", planType: "pro" };
const cases = [
  { name: "native success", routing: {}, native: true },
  { name: "native quota failure", routing: {}, native: true, quotaError: true },
  {
    name: "custom Go Codex with a stored ChatGPT login",
    routing: {
      model_provider: "hub",
      model_providers: { hub: { base_url: "https://hub.test/v1" } },
    },
    native: false,
  },
  {
    name: "native instance bound to an external Go account",
    routing: {},
    native: false,
    bound: true,
  },
  { name: "config read fails", routing: {}, native: false, configError: true },
  { name: "malformed routing", routing: { model_providers: "invalid" }, native: false },
  {
    name: "custom OpenAI base URL",
    routing: { openai_base_url: "https://hub.test/v1" },
    native: false,
  },
  { name: "API key with native routing", routing: {}, native: false, apiKey: true },
  { name: "OpenAI auth not required", routing: {}, native: false, noAuth: true },
] as const;

for (const fixture of cases) {
  it.live.skipIf(windowsHost)(`quota RPC routing: ${fixture.name}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-synthetic-quota-" });
      const calls = path.join(dir, "calls.jsonl");
      const binaryPath = path.join(dir, "fake-codex");
      const options = {
        ...fixture,
        calls,
        account: "apiKey" in fixture ? { type: "apiKey" } : chatgpt,
      };
      yield* fs.writeFileString(
        binaryPath,
        `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const f = ${encodeJson(options)};
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  fs.appendFileSync(f.calls, JSON.stringify(request.method) + "\\n");
  let result;
  let error;
  switch (request.method) {
    case "initialize": result = { userAgent: "fake/1.0", codexHome: ${encodeJson(dir)}, platformFamily: "unix", platformOs: "macos" }; break;
    case "account/read": result = { account: f.account, requiresOpenaiAuth: !f.noAuth }; break;
    case "skills/list": result = { data: [] }; break;
    case "model/list": result = { data: [] }; break;
    case "config/read":
      if (f.configError) error = { code: -32600, message: "synthetic config failure" };
      else result = { config: f.routing, origins: {} };
      break;
    case "account/rateLimits/read":
      if (f.quotaError) error = { code: -32600, message: "synthetic quota failure" };
      else result = { rateLimits: { primary: { usedPercent: 60, windowDurationMins: 300 } } };
      break;
    default: error = { code: -32601, message: "unexpected request" };
  }
  process.stdout.write(JSON.stringify({ id: request.id, ...(error ? { error } : { result }) }) + "\\n");
});
`,
      );
      yield* fs.chmod(binaryPath, 0o755);
      const status = yield* checkCodexProviderStatus(
        yield* decodeSettings({
          binaryPath,
          homePath: dir,
          modelCatalogMode: "custom-only",
        }),
        undefined,
        {},
        "bound" in fixture,
      );
      const methods = (yield* fs.readFileString(calls))
        .trim()
        .split("\n")
        .map((line) => decodeMethod(line));
      expect(methods.filter((method) => method === "account/rateLimits/read").length).toBe(
        fixture.native ? 1 : 0,
      );
      expect(status.status).toBe("ready");
      if (!fixture.native) {
        expect(status.usageLimits).toMatchObject({
          windows: [],
          unavailable: { reason: "unsupported" },
        });
        const previous = {
          checkedAt: status.checkedAt,
          windows: [{ id: "primary", kind: "session" as const, label: "Session", usedPercent: 99 }],
        };
        const resolved = resolveUsageLimitsAfterProbe({
          published: previous,
          probed: status.usageLimits,
        });
        expect(resolved?.windows).toEqual([]);
        expect(
          applyUsageLimitsUpdate({
            previous: resolved,
            checkedAt: status.checkedAt,
            update: { windows: previous.windows },
          }),
        ).toBe(resolved);
      } else if ("quotaError" in fixture) {
        expect(status.usageLimits?.unavailable).toMatchObject({ reason: "probeFailed" });
      } else {
        expect(status.usageLimits?.windows[0]?.usedPercent).toBe(60);
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
}

it.effect("a Claude source binding skips every Go credential read and HTTP request", () =>
  Effect.gen(function* () {
    const result = yield* readOpenCodeGoUsageLimits({
      enabled: true,
      serverUrl: "",
      skipNativeUsage: true,
      environment: { OPENCODE_AUTH_CONTENT: "invalid-auth-must-not-be-read" },
    });
    expect(result).toMatchObject({ windows: [], unavailable: { reason: "unsupported" } });
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected Go request")),
    ),
  ),
);

it.effect("bound instances reject streamed native windows from their initial snapshot", () =>
  Effect.gen(function* () {
    const pending = yield* makePendingCodexProvider(yield* decodeSettings({ enabled: false }));
    const snapshot = withInstanceIdentity({
      instanceId: ProviderInstanceId.make("synthetic-go-codex"),
      driverKind: ProviderDriverKind.make("codex"),
      displayName: undefined,
      accentColor: undefined,
      continuationGroupKey: "synthetic",
      usageSource: {
        sourceId: UsageLimitSourceId.make("syntheticHub"),
        accountId: "magpie-go:synthetic-go",
      },
    })(pending);
    expect(snapshot.usageLimits?.unavailable?.reason).toBe("unsupported");
    expect(
      applyUsageLimitsUpdate({
        previous: snapshot.usageLimits,
        checkedAt: snapshot.checkedAt,
        update: {
          windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 99 }],
        },
      }),
    ).toBe(snapshot.usageLimits);
  }),
);
