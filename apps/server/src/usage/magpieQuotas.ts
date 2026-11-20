/**
 * Magpie gateway quotas: `GET /v1/magpie/quotas` reports every pooled account.
 * Gateways are found from the base URLs enabled instances already use; an
 * origin that does not answer the route is not a gateway and is dropped.
 */
import * as NodeOS from "node:os";

import {
  ProviderDriverKind,
  UsageLimitSourceError,
  type ServerProviderUsageWindow,
  type ServerSettings,
  type UsageLimitSourceAccount,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { parse as parseJsonc } from "jsonc-parser";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

import { codexPlanLabel } from "../provider/CodexProvider.ts";

const QuotaWindow = Schema.Struct({
  name: Schema.String,
  used: Schema.Finite,
  resetsAt: Schema.optional(Schema.NullOr(Schema.String)),
});
const QuotaEntry = Schema.Struct({
  provider: Schema.String,
  name: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  plan: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  windows: Schema.optional(Schema.Array(QuotaWindow)),
  readAt: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
const QuotasResponse = Schema.Struct({ data: Schema.Array(QuotaEntry) });
const isProviderDriverKind = Schema.is(ProviderDriverKind);
const isUsageLimitSourceError = Schema.is(UsageLimitSourceError);
export type MagpieQuotaEntry = typeof QuotaEntry.Type;

const MINUTES: Record<string, number> = {
  minute: 1,
  hour: 60,
  day: 24 * 60,
  week: 7 * 24 * 60,
  month: 30 * 24 * 60,
};

/** Magpie's provider names → the driver whose icon and pool the account joins. */
function driverFor(provider: string): ProviderDriverKind | null {
  switch (provider) {
    case "claude":
      return ProviderDriverKind.make("claudeAgent");
    case "codex":
      return ProviderDriverKind.make("codex");
    case "magpie-go":
    case "opencode-go":
    case "opencode":
      return ProviderDriverKind.make("opencode");
    case "grok":
      return ProviderDriverKind.make("grok");
    default:
      return isProviderDriverKind(provider) ? provider : null;
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * `5 hours`, `7 days`, `7 days · Fable` → a window whose id matches what the
 * driver's own probe would publish (Claude `five_hour`/`seven_day`, Codex
 * `primary`/`secondary`), so a native read and a gateway read of the same
 * account land on the same row.
 */
function magpieWindow(
  driver: ProviderDriverKind,
  window: typeof QuotaWindow.Type,
): ServerProviderUsageWindow {
  const [span = window.name, ...scopeParts] = window.name.split("·").map((part) => part.trim());
  const scope = scopeParts.join(" · ");
  const match = /^(?:(\d+(?:\.\d+)?)\s+)?(minute|hour|day|week|month)s?$/i.exec(span);
  const mins = match
    ? Number(match[1] ?? 1) * MINUTES[match[2]!.toLowerCase()]!
    : undefined;
  const kind: ServerProviderUsageWindow["kind"] =
    mins === undefined
      ? "other"
      : mins >= MINUTES.month!
        ? "monthly"
        : mins >= MINUTES.week!
          ? "weekly"
          : "session";
  const baseLabel =
    kind === "session"
      ? "Session"
      : kind === "weekly"
        ? "Weekly"
        : kind === "monthly"
          ? "Monthly"
          : span;
  const baseId =
    driver === "claudeAgent" && mins === 5 * 60
      ? "five_hour"
      : driver === "claudeAgent" && mins === MINUTES.week
        ? "seven_day"
        : driver === "codex" && kind === "weekly"
          ? "secondary"
          : driver === "codex" && kind !== "other"
            ? "primary"
            : driver === "grok"
              ? "subscription"
              : slug(span) || "window";
  const parsedReset = window.resetsAt ? DateTime.make(window.resetsAt) : Option.none();
  const resetsAt = Option.isSome(parsedReset) ? DateTime.formatIso(parsedReset.value) : undefined;
  return {
    id: scope ? `${baseId}_${slug(scope)}` : baseId,
    kind,
    label: scope ? `${baseLabel} · ${scope}` : baseLabel,
    usedPercent: clampPercent(window.used),
    ...(mins !== undefined ? { windowDurationMins: mins } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function planLabel(driver: ProviderDriverKind, entry: MagpieQuotaEntry): string | undefined {
  if (!entry.plan) return entry.kind === "plan" ? entry.name : undefined;
  if (driver === "codex") return codexPlanLabel(entry.plan) ?? entry.plan;
  if (driver === "claudeAgent") {
    return `Claude ${entry.plan.charAt(0).toUpperCase()}${entry.plan.slice(1)}`;
  }
  return entry.plan;
}

/**
 * A vendor refusal that will not clear by itself (no subscription on the key,
 * a lapsed workspace) is "not applicable", not a failure to retry.
 */
function isStandingRefusal(error: string): boolean {
  return /payment required|no .*subscription|not subscribed|no active (plan|subscription)/i.test(
    error,
  );
}

/** OpenCode's own sentence for a key that was never subscribed. */
function isDeadGoSubscription(error: string): boolean {
  return /this key has no opencode go subscription/i.test(error);
}

/** Magpie's sentences run long; the first clause names the reason. */
function shortReason(error: string): string {
  const first = error.split(/[:;]\s/)[0]!.trim();
  const sentence = first.charAt(0).toUpperCase() + first.slice(1);
  return sentence.endsWith(".") ? sentence : `${sentence}.`;
}

export function magpieQuotasToAccounts(
  entries: ReadonlyArray<MagpieQuotaEntry>,
  checkedAt: string,
): ReadonlyArray<UsageLimitSourceAccount> {
  const accounts: UsageLimitSourceAccount[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const driver = driverFor(entry.provider);
    if (!driver) continue;
    if (driver === "opencode" && entry.error && isDeadGoSubscription(entry.error)) {
      continue;
    }
    const user = entry.user?.trim() || entry.name?.trim() || entry.provider;
    const id = `${entry.provider}:${user}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const windows = (entry.windows ?? []).map((window) => magpieWindow(driver, window));
    const plan = planLabel(driver, entry);
    const usageLimits = entry.error
      ? makeUnavailableUsageLimits({
          checkedAt: entry.readAt ?? checkedAt,
          reason: isStandingRefusal(entry.error) ? "unsupported" : "probeFailed",
          message: shortReason(entry.error),
        })
      : makeUsageLimits({ checkedAt: entry.readAt ?? checkedAt, windows });
    accounts.push({
      id,
      driver,
      // Only a real address is an email; Go keys carry a key name instead.
      ...(/^[^\s@]+@[^\s@]+$/.test(user.split(" · ")[0]!) ? { email: user } : {}),
      ...(plan ? { plan } : {}),
      usageLimits,
    });
  }
  return accounts;
}

export const makeMagpieApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const readAccounts = Effect.fn("MagpieApi.readAccounts")(function* (config: {
    readonly url: string;
    readonly managementKey: string;
  }): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const origin = gatewayOrigin(config.url);
    if (!origin) {
      return yield* new UsageLimitSourceError({ detail: "The Magpie gateway URL is not valid." });
    }
    const request = HttpClientRequest.get(`${origin}/v1/magpie/quotas`).pipe(
      config.managementKey ? HttpClientRequest.bearerToken(config.managementKey) : (r) => r,
    );
    // One deadline covers headers and body: a stalled body must not hold the refresh lock.
    const body = yield* client.execute(request).pipe(
      Effect.flatMap((response) =>
        response.status === 401 || response.status === 403
          ? Effect.fail(
              new UsageLimitSourceError({
                detail: "The Magpie gateway refused the key. Add the gateway key to this source.",
              }),
            )
          : HttpClientResponse.filterStatusOk(response).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(QuotasResponse)),
              Effect.mapError(
                () =>
                  new UsageLimitSourceError({
                    detail: "The Magpie gateway did not report quotas.",
                  }),
              ),
            ),
      ),
      Effect.timeout("5 seconds"),
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({ detail: "The Magpie gateway did not answer." }),
      ),
    );
    return magpieQuotasToAccounts(body.data, DateTime.formatIso(yield* DateTime.now));
  });
  return { readAccounts };
});

/** `http://127.0.0.1:3425/v1` → `http://127.0.0.1:3425`; anything not http(s) is no gateway. */
export function gatewayOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Discovery only knocks on hosts the user runs: loopback, private and
 * tailnet ranges. A vendor API an instance also names never gets the probe.
 */
export function isPrivateOrigin(origin: string): boolean {
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (host.endsWith(".ts.net") || (host.includes(":") && /^f[cd]/.test(host))) return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [a = -1, b = -1] = octets;
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** The selected provider's `base_url` in a Codex `config.toml`, or a `-c model_provider=` override. */
export function codexBaseUrl(toml: string, launchArgs: string | undefined): string | undefined {
  const override = /model_provider\s*=\s*"?([\w.-]+)"?/.exec(launchArgs ?? "")?.[1];
  const provider = override ?? /^\s*model_provider\s*=\s*["']([^"']+)["']/m.exec(toml)?.[1];
  if (!provider) return undefined;
  let inSection = false;
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1]?.trim();
    if (header !== undefined) {
      inSection = header === `model_providers.${provider}`;
      continue;
    }
    if (!inSection) continue;
    const value = /^\s*base_url\s*=\s*["']([^"']+)["']/.exec(line)?.[1];
    if (value) return value;
  }
  return undefined;
}

/** Every `provider.*.options.baseURL` in an OpenCode config file. */
export function openCodeBaseUrls(jsonc: string): ReadonlyArray<string> {
  const parsed: unknown = parseJsonc(jsonc);
  if (typeof parsed !== "object" || parsed === null) return [];
  const providers = (parsed as { provider?: unknown }).provider;
  if (typeof providers !== "object" || providers === null) return [];
  return Object.values(providers).flatMap((entry) => {
    const baseURL = (entry as { options?: { baseURL?: unknown } } | null)?.options?.baseURL;
    return typeof baseURL === "string" ? [baseURL] : [];
  });
}

function settingsArg(launchArgs: string | undefined): string | undefined {
  return /--settings(?:=|\s+)(\S+)/.exec(launchArgs ?? "")?.[1];
}

function instanceConfig(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Distinct gateway origins the enabled provider instances send requests to.
 * A file that is missing or unreadable contributes nothing.
 */
export const discoverGatewayOrigins = Effect.fn("discoverGatewayOrigins")(function* (
  settings: Pick<ServerSettings, "providerInstances">,
  env: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = env.HOME || env.USERPROFILE || NodeOS.homedir();
  const read = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  const urls: string[] = [];
  for (const instance of Object.values(settings.providerInstances)) {
    if (instance.enabled === false) continue;
    const config = instanceConfig(instance.config);
    const launchArgs = stringField(config, "launchArgs");
    // A secret-provider reference is not a plain path or URL; skip it.
    const envValue = (name: string) => {
      const value = instance.environment?.find((variable) => variable.name === name)?.value;
      return (typeof value === "string" && value) || env[name];
    };
    switch (instance.driver) {
      case "codex": {
        const codexHome =
          stringField(config, "homePath") ?? envValue("CODEX_HOME") ?? path.join(home, ".codex");
        const url = codexBaseUrl(yield* read(path.join(codexHome, "config.toml")), launchArgs);
        if (url) urls.push(url);
        break;
      }
      case "opencode": {
        const configHome = envValue("XDG_CONFIG_HOME") || path.join(home, ".config");
        const explicit = envValue("OPENCODE_CONFIG");
        const files = explicit
          ? [explicit]
          : ["opencode.jsonc", "opencode.json"].map((name) =>
              path.join(configHome, "opencode", name),
            );
        for (const file of files) urls.push(...openCodeBaseUrls(yield* read(file)));
        break;
      }
      case "claudeAgent": {
        const fromEnv = envValue("ANTHROPIC_BASE_URL");
        if (fromEnv) urls.push(fromEnv);
        const files = [settingsArg(launchArgs), stringField(config, "homePath")]
          .filter((file): file is string => Boolean(file))
          .map((file) => (file.endsWith(".json") ? file : path.join(file, "settings.json")));
        for (const file of files) {
          const parsed: unknown = parseJsonc(yield* read(file));
          const url = (parsed as { env?: { ANTHROPIC_BASE_URL?: unknown } } | null)?.env
            ?.ANTHROPIC_BASE_URL;
          if (typeof url === "string") urls.push(url);
        }
        break;
      }
    }
  }
  const origins = urls.map(gatewayOrigin).filter((origin): origin is string => !!origin);
  return [...new Set(origins)].filter(isPrivateOrigin);
});
