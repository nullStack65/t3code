import * as NodeModule from "node:module";

import type { AntigravitySettings, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

export function antigravityUserAgent(platform: NodeJS.Platform, architecture: NodeJS.Architecture) {
  return `antigravity/hub/2.24.0 (aidev_client; os_type=${platform}; arch=${architecture}; cl=963137146)`;
}

const DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com";
// The ACP runtime meters consumer tiers on the daily host and GCP-terms tiers on prod.
// The sign-in method stands in for the tier.
const ENDPOINTS = {
  "oauth-personal": [DAILY_ENDPOINT, PROD_ENDPOINT],
  "oauth-business": [PROD_ENDPOINT, DAILY_ENDPOINT],
};
const SUMMARY_WINDOW_MINS = new Map([
  ["5h", 5 * 60],
  ["weekly", 7 * 24 * 60],
]);
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
const TokenFile = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  project_id: Schema.optional(Schema.String),
});
const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
});
const UserInfo = Schema.Struct({ id: Schema.NonEmptyString });
const Quota = Schema.Struct({
  remainingFraction: Schema.optional(Schema.Number),
  resetTime: Schema.optional(Schema.String),
});
const Bucket = Schema.Struct({
  ...Quota.fields,
  bucketId: Schema.NonEmptyString,
  window: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});
const Summary = Schema.Struct({
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        displayName: Schema.optional(Schema.String),
        buckets: Schema.optional(Schema.Array(Bucket)),
      }),
    ),
  ),
  buckets: Schema.optional(Schema.Array(Bucket)),
});
const Models = Schema.Struct({
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      modelProvider: Schema.optional(Schema.String),
      quotaInfo: Schema.optional(Quota),
      weeklyQuotaInfo: Schema.optional(Quota),
    }),
  ),
});

const decodeTokenFile = Schema.decodeEffect(Schema.fromJsonString(TokenFile));
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);
const decodeUserInfo = Schema.decodeUnknownEffect(UserInfo);
const decodeSummary = Schema.decodeUnknownEffect(Summary);
const decodeModels = Schema.decodeUnknownEffect(Models);

function iso(value: string | undefined): string | undefined {
  const parsed = value ? DateTime.make(value) : Option.none();
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function quotaWindow(
  id: string,
  label: string,
  quota: typeof Quota.Type,
  kind: ServerProviderUsageWindow["kind"] = "other",
  windowDurationMins?: number,
): ServerProviderUsageWindow | undefined {
  if (quota.remainingFraction === undefined || !Number.isFinite(quota.remainingFraction)) {
    return undefined;
  }
  const resetsAt = iso(quota.resetTime);
  return {
    id,
    label,
    kind,
    usedPercent: (1 - Math.max(0, Math.min(1, quota.remainingFraction))) * 100,
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  };
}

function summaryResetTime(
  bucket: typeof Bucket.Type,
  windowDurationMins: number | undefined,
  requestedAt: number,
): string | undefined {
  // Untouched summary buckets report a rolling full-window reset.
  const untouched =
    bucket.remainingFraction === 1 &&
    bucket.description === undefined &&
    windowDurationMins !== undefined &&
    Math.abs(Date.parse(bucket.resetTime ?? "") - requestedAt - windowDurationMins * 60_000) <=
      60_000;
  return untouched ? undefined : bucket.resetTime;
}

const CLI_ACCESS_CACHE_MS = 5 * 60 * 1000;
const KEYRING_SERVICE = "gemini";
const KEYRING_ACCOUNT = "antigravity";

export interface AntigravityCliAccess {
  readonly accessToken: string;
  readonly identity: string;
  readonly expiresAtMs?: number;
}

/** Google writes nanoseconds. `Date.parse` only has to accept milliseconds. */
function trimAntigravityTimestamp(value: string) {
  const normalized = value.endsWith("Z") ? `${value.slice(0, -1)}+00:00` : value;
  const dot = normalized.indexOf(".");
  if (dot < 0) return normalized;
  let index = dot + 1;
  let digits = "";
  while (
    index < normalized.length &&
    normalized.charCodeAt(index) >= 48 &&
    normalized.charCodeAt(index) <= 57
  ) {
    if (digits.length < 3) digits += normalized[index];
    index += 1;
  }
  return `${normalized.slice(0, dot)}${digits ? `.${digits}` : ""}${normalized.slice(index)}`;
}

function timestampMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Date.parse(trimAntigravityTimestamp(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * `agy` 1.5 stores this JSON in the Secret Service (service `gemini`, account
 * `antigravity`) and does not write `acp_token.json`. There is no client secret,
 * so the access token is used as-is.
 */
export function parseAntigravityCliCredential(
  raw: string,
  nowMs: number,
): AntigravityCliAccess | "expired" | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const token =
    record.token && typeof record.token === "object"
      ? (record.token as Record<string, unknown>)
      : record;
  const accessToken = typeof token.access_token === "string" ? token.access_token : "";
  if (!accessToken) return undefined;
  const refreshToken = typeof token.refresh_token === "string" ? token.refresh_token : "";
  const expiresAtMs = timestampMillis(token.expiry ?? record.expiry);
  if (expiresAtMs !== undefined && expiresAtMs <= nowMs) return "expired";
  return {
    accessToken,
    identity: refreshToken || accessToken,
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
  };
}

// A single-executable server cannot import() a file-backed package; createRequire resolves it beside the
// executable, as the other native externals do.
const requireForKeyring = NodeModule.createRequire(import.meta.url);

// The stored value is the OAuth token. Keep it out of span attributes.
const readDefaultStoredSecret = Effect.fnUntraced(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  const fromModule = yield* Effect.tryPromise({
    try: async () => {
      const keyring = requireForKeyring("@napi-rs/keyring") as {
        readonly AsyncEntry?: new (
          service: string,
          account: string,
        ) => { getPassword(): Promise<string | null> };
        readonly Entry?: new (
          service: string,
          account: string,
        ) => { getPassword(): Promise<string | null> | string | null };
      };
      const Entry = keyring.AsyncEntry ?? keyring.Entry;
      if (!Entry) return null;
      const secret = await new Entry(KEYRING_SERVICE, KEYRING_ACCOUNT).getPassword();
      return typeof secret === "string" && secret.length > 0 ? secret : null;
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));
  if (fromModule) return fromModule;
  const platform = yield* HostProcess.Platform;
  const command =
    platform === "linux"
      ? {
          command: "secret-tool",
          args: ["lookup", "service", KEYRING_SERVICE, "username", KEYRING_ACCOUNT],
        }
      : platform === "darwin"
        ? {
            command: "security",
            args: ["find-generic-password", "-s", KEYRING_SERVICE, "-a", KEYRING_ACCOUNT, "-w"],
          }
        : undefined;
  if (!command) return null;
  const output = yield* spawner
    .string(ChildProcess.make(command.command, command.args, { stderr: "ignore" }))
    .pipe(Effect.orElseSucceed(() => ""));
  const secret = output.trim();
  return secret.length > 0 ? secret : null;
});

const sha256 = Effect.fnUntraced(function* (text: string) {
  const digest = yield* (yield* Digest.Digest).digest(
    Digest.sha256,
    new TextEncoder().encode(text),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

/** Keys an account by its Google ID, which matches across machines and hubs; refresh tokens do not. */
export const antigravityAccountFingerprint = (userInfo: unknown) =>
  decodeUserInfo(userInfo).pipe(Effect.flatMap((info) => sha256(`google-account\0${info.id}`)));

/** Windows from a `retrieveUserQuotaSummary` answer requested at `requestedAt`. */
export const antigravitySummaryWindows = (response: unknown, requestedAt: number) =>
  decodeSummary(response).pipe(Effect.map((summary) => summaryWindows(summary, requestedAt)));

function summaryWindows(summary: typeof Summary.Type, requestedAt: number) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  const groups = summary.groups?.some((group) => group.buckets?.length)
    ? summary.groups
    : [{ buckets: summary.buckets }];
  for (const group of groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      if (bucket.disabled) continue;
      // Argon and Carbon are metered separately from the default Gemini buckets.
      const family = bucket.bucketId.startsWith("gemini-argon-")
        ? group.displayName?.trim() || "Gemini Argon"
        : bucket.bucketId.startsWith("gemini-carbon-")
          ? group.displayName?.trim() || "Gemini Carbon"
          : bucket.bucketId.startsWith("gemini-")
            ? "Gemini"
            : bucket.bucketId.startsWith("3p-")
              ? "Claude & GPT (shared)"
              : group.displayName?.trim() || bucket.bucketId;
      const weekly = bucket.window === "weekly";
      const session = bucket.window === "5h";
      const windowDurationMins = SUMMARY_WINDOW_MINS.get(bucket.window ?? "");
      const window = quotaWindow(
        bucket.bucketId,
        `${family} · ${weekly ? "Weekly" : session ? "5-hour" : bucket.displayName?.trim() || "Quota"}`,
        { ...bucket, resetTime: summaryResetTime(bucket, windowDurationMins, requestedAt) },
        weekly ? "weekly" : session ? "session" : "other",
        windowDurationMins,
      );
      if (window) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}

/** Older accounts expose model quotas without a window length. Do not invent a reset cadence. */
function modelWindows(models: typeof Models.Type) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const [modelId, model] of Object.entries(models.models)) {
    const family =
      model.modelProvider === "MODEL_PROVIDER_GOOGLE" || modelId.startsWith("gemini-")
        ? "Gemini"
        : model.modelProvider === "MODEL_PROVIDER_ANTHROPIC" || modelId.startsWith("claude-")
          ? "Claude"
          : model.modelProvider === "MODEL_PROVIDER_OPENAI" || modelId.startsWith("gpt-")
            ? "GPT"
            : undefined;
    if (!family) continue;
    for (const [suffix, quota] of [
      ["quota", model.quotaInfo],
      ["weekly", model.weeklyQuotaInfo],
    ] as const) {
      if (!quota) continue;
      const window = quotaWindow(
        `${family.toLowerCase()}-${suffix}`,
        `${family} · ${suffix === "weekly" ? "Weekly" : "Reported quota"}`,
        quota,
        suffix === "weekly" ? "weekly" : "other",
        suffix === "weekly" ? 7 * 24 * 60 : undefined,
      );
      if (!window) continue;
      const previous = windows.get(window.id);
      if (!previous || window.usedPercent > previous.usedPercent) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}

const discoverAntigravityCliAccess = Effect.fn("AntigravityUsageProbe.discoverCliAccess")(
  function* (input: {
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly homeDirectory: string;
    readonly profileDirectory: string;
    readonly nowMs: number;
    readonly readStoredSecret?: Effect.Effect<string | null>;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  }) {
    const files = [
      input.path.join(input.profileDirectory, "antigravity-acp", "antigravity-oauth-token"),
      input.path.join(input.profileDirectory, "antigravity-oauth-token"),
      input.path.join(input.homeDirectory, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    ];
    let expired = false;
    for (const file of files) {
      if (!(yield* input.fs.exists(file))) continue;
      const raw = yield* input.fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      const parsed = parseAntigravityCliCredential(raw, input.nowMs);
      if (parsed === "expired") {
        expired = true;
        continue;
      }
      if (parsed) return parsed;
    }
    const secret = yield* input.readStoredSecret ?? readDefaultStoredSecret(input.spawner);
    if (secret) {
      const parsed = parseAntigravityCliCredential(secret, input.nowMs);
      if (parsed === "expired") return "expired" as const;
      if (parsed) return parsed;
    }
    return expired ? ("expired" as const) : null;
  },
);

export const makeAntigravityUsageProbe = Effect.fn("makeAntigravityUsageProbe")(function* (input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravitySettings["authMethod"];
  /**
   * Present only in tests. `null` is signed out, `"expired"` is a lapsed CLI
   * token, and an access value is used directly. Omitting it reads the CLI files
   * and the keyring.
   */
  readonly cliAccess?: AntigravityCliAccess | "expired" | null;
  readonly readStoredSecret?: Effect.Effect<string | null>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const crypto = yield* Digest.Digest;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const tokenPath = path.join(input.profileDirectory, "antigravity-acp", "acp_token.json");
  let cached:
    | { fingerprint: string; account: string; accessToken: string; expiresAt: number }
    | undefined;
  let generation = 0;

  const request = (request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout("10 seconds"),
    );
  const read = Effect.gen(function* () {
    const startedGeneration = generation;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (input.authMethod !== "oauth-personal" && input.authMethod !== "oauth-business") {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message:
          "Not applicable: Antigravity API keys and Agent Platform are billed by Google. T3 has no quota window for them.",
      });
    }
    const now = yield* Clock.currentTimeMillis;
    const signedOut = makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "Sign in with Google to see limits.",
    });
    const lapsed = makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message:
        "Antigravity's saved access token has lapsed. A running agy session refreshes it; the Antigravity app does not need to be open.",
    });
    let accessToken: string;
    let account: string;
    let projectId: string | undefined;
    if (yield* fs.exists(tokenPath)) {
      const token = yield* fs.readFileString(tokenPath).pipe(Effect.flatMap(decodeTokenFile));
      projectId = token.project_id;
      const fingerprint = yield* sha256(
        `${token.client_id}\0${token.refresh_token}\0${token.project_id ?? ""}`,
      );
      if (cached?.fingerprint !== fingerprint || cached.expiresAt <= now + 60_000) {
        cached = undefined;
        const refreshed = yield* request(
          HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
            HttpClientRequest.bodyUrlParams({
              client_id: token.client_id,
              client_secret: token.client_secret,
              refresh_token: token.refresh_token,
              grant_type: "refresh_token",
            }),
          ),
        ).pipe(Effect.flatMap(decodeTokenResponse));
        accessToken = refreshed.access_token;
        // Use Google account IDs to merge accounts across environments; refresh tokens differ per machine.
        account = yield* request(
          HttpClientRequest.get("https://www.googleapis.com/oauth2/v2/userinfo").pipe(
            HttpClientRequest.setHeaders({ Authorization: `Bearer ${accessToken}` }),
          ),
        ).pipe(
          Effect.flatMap(antigravityAccountFingerprint),
          Effect.orElseSucceed(() => fingerprint),
        );
        if (generation === startedGeneration) {
          cached = {
            fingerprint,
            account,
            accessToken,
            expiresAt: now + refreshed.expires_in * 1000,
          };
        }
      } else {
        accessToken = cached.accessToken;
        account = cached.account;
      }
    } else {
      const cli =
        "cliAccess" in input
          ? (input.cliAccess ?? null)
          : yield* discoverAntigravityCliAccess({
              fs,
              path,
              homeDirectory,
              profileDirectory: input.profileDirectory,
              nowMs: now,
              spawner,
              ...(input.readStoredSecret ? { readStoredSecret: input.readStoredSecret } : {}),
            });
      if (cli === null) {
        cached = undefined;
        return signedOut;
      }
      if (cli === "expired") {
        cached = undefined;
        return lapsed;
      }
      const fingerprint = yield* sha256(`cli-access\0${cli.identity}`);
      if (cached?.fingerprint !== fingerprint || cached.expiresAt <= now) {
        cached = undefined;
        accessToken = cli.accessToken;
        account = yield* request(
          HttpClientRequest.get("https://www.googleapis.com/oauth2/v2/userinfo").pipe(
            HttpClientRequest.setHeaders({ Authorization: `Bearer ${accessToken}` }),
          ),
        ).pipe(
          Effect.flatMap(antigravityAccountFingerprint),
          Effect.orElseSucceed(() => fingerprint),
        );
        if (generation === startedGeneration) {
          cached = {
            fingerprint,
            account,
            accessToken,
            expiresAt: cli.expiresAtMs ?? now + CLI_ACCESS_CACHE_MS,
          };
        }
      } else {
        accessToken = cached.accessToken;
        account = cached.account;
      }
    }
    const endpoints = ENDPOINTS[input.authMethod];
    // Merge endpoints because quota groups differ; the metered host's reading of a bucket wins.
    const fetchWindows = Effect.fn("AntigravityUsageProbe.fetchWindows")(function* <E>(
      operation: string,
      parse: (
        response: unknown,
        requestedAt: number,
      ) => Effect.Effect<ServerProviderUsageWindow[], E>,
    ) {
      const responses = yield* Effect.forEach(
        endpoints,
        (endpoint) =>
          Effect.gen(function* () {
            // Capture each request after auth, so refresh latency does not widen the tolerance.
            const requestedAt = yield* Clock.currentTimeMillis;
            return yield* request(
              HttpClientRequest.post(`${endpoint}/v1internal:${operation}`).pipe(
                HttpClientRequest.setHeaders({
                  Authorization: `Bearer ${accessToken}`,
                  "User-Agent": antigravityUserAgent(platform, architecture),
                }),
                HttpClientRequest.bodyJsonUnsafe(projectId ? { project: projectId } : {}),
              ),
            ).pipe(
              Effect.flatMap((response) => parse(response, requestedAt)),
              Effect.orElseSucceed(() => []),
            );
          }),
        { concurrency: "unbounded" },
      );
      const windows = new Map<string, ServerProviderUsageWindow>();
      for (const window of responses.flat()) {
        if (!windows.has(window.id)) windows.set(window.id, window);
      }
      return [...windows.values()];
    });
    const summary = yield* fetchWindows("retrieveUserQuotaSummary", antigravitySummaryWindows);
    // A summary of only untouched buckets is not a Gemini reading.
    const metered = summary.some(
      (window) => window.usedPercent > 0 || window.resetsAt !== undefined,
    );
    const models = metered
      ? []
      : yield* fetchWindows("fetchAvailableModels", (response) =>
          decodeModels(response).pipe(Effect.map(modelWindows)),
        );
    const windows = models.length > 0 ? models : summary;
    if (windows.length === 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Antigravity did not return usable quota information.",
      });
    }
    return { ...makeUsageLimits({ checkedAt, windows }), credentialFingerprint: account };
  });
  const probe = read.pipe(
    Effect.provideService(Digest.Digest, crypto),
    Effect.timeout("30 seconds"),
    Effect.catch(() =>
      Effect.gen(function* () {
        return makeUnavailableUsageLimits({
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          reason: "probeFailed",
          message: "Could not read Antigravity limits. Refresh provider status to retry.",
        });
      }),
    ),
  );
  return {
    probe,
    clear: Effect.sync(() => {
      cached = undefined;
      generation++;
    }),
  };
});
