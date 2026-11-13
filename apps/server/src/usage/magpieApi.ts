import {
  ProviderDriverKind,
  UsageLimitSourceError,
  type UsageLimitSourceAccount,
  type UsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";

import { codexRateLimitsToLimits } from "../provider/Layers/codexUsageLimits.ts";
import { claudeUsageResponseToLimits } from "../provider/Layers/claudeUsageLimits.ts";
import { makeUnavailableUsageLimits, makeUsageLimits } from "../provider/providerUsageLimits.ts";

const Percent = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const Text = Schema.String.check(Schema.isMaxLength(256));
const Window = Schema.Struct({
  name: Text,
  used: Percent,
  remaining: Percent,
  resetsAt: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtcFromString)),
});
const Cards = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      provider: Schema.Literals(["claude", "codex", "magpie-go"]),
      name: Text.check(Schema.isMinLength(1)),
      kind: Text,
      user: Schema.NullOr(Text),
      plan: Schema.optionalKey(Schema.NullOr(Text)),
      windows: Schema.Array(Window).check(Schema.isMaxLength(32)),
      readAt: Schema.DateTimeUtcFromString,
      error: Schema.optionalKey(Schema.Unknown),
    }),
  ).check(Schema.isMaxLength(128)),
});
const decodeCards = Schema.decodeUnknownEffect(Cards);
const MAX_BODY_BYTES = 256 * 1024;
const MAX_AGE_MS = 10 * 60 * 1000;

const decodeAccountError = Schema.decodeUnknownOption(
  Schema.Struct({
    code: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(Schema.String),
  }),
);
const isSourceError = Schema.is(UsageLimitSourceError);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

// Vendor error bodies can contain auth material. Preserve only known account states.
function accountError(error: unknown): string | undefined {
  if (error === undefined || error === null || error === "") return undefined;
  const parsed = decodeAccountError(error);
  const text = (
    typeof error === "string"
      ? error
      : Option.isSome(parsed)
        ? `${parsed.value.code ?? ""} ${parsed.value.message ?? ""}`
        : ""
  ).toLowerCase();
  if (text.includes("no-subscription")) return "Magpie account has no subscription.";
  if (text.includes("paymentrequired") || text.includes("payment required"))
    return "Magpie account requires payment (PaymentRequired).";
  if (text.includes("lapsed")) return "Magpie account subscription has lapsed.";
  if (text.includes("signedout") || text.includes("signed out"))
    return "Magpie account is signed out.";
  return "Magpie reported an account error.";
}

export const readMagpieAccounts = Effect.fn("MagpieApi.readAccounts")(function* (
  config: UsageLimitSourceConfig,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
  const apiKey = config.apiKeyEnv ? environment[config.apiKeyEnv]?.trim() : undefined;
  if (!apiKey) {
    return yield* new UsageLimitSourceError({
      detail: "The Magpie API key environment variable is missing.",
    });
  }
  const url = yield* Effect.try({
    try: () => {
      const base = new URL(config.url);
      if (
        !["http:", "https:"].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
      )
        throw new Error("Invalid URL");
      return new URL("/v1/magpie/quotas", base);
    },
    catch: () => new UsageLimitSourceError({ detail: "The Magpie URL is invalid." }),
  });
  const fetch = yield* FetchHttpClient.Fetch;
  const raw = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        redirect: "manual",
        signal,
      });
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        throw new UsageLimitSourceError({
          detail:
            response.status >= 300 && response.status < 400
              ? "Magpie quota redirects are refused."
              : `Magpie quota request failed (HTTP ${response.status}).`,
        });
      }
      const reader = response.body?.getReader();
      if (!reader)
        throw new UsageLimitSourceError({ detail: "Magpie returned an invalid quota response." });
      try {
        let size = 0;
        let body = "";
        const decoder = new TextDecoder();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_BODY_BYTES) {
            throw new UsageLimitSourceError({
              detail: "Magpie quota response exceeded the size limit.",
            });
          }
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
        try {
          return decodeJson(body);
        } catch {
          throw new UsageLimitSourceError({ detail: "Magpie returned invalid quota JSON." });
        }
      } finally {
        await reader.cancel();
      }
    },
    catch: (error) =>
      isSourceError(error)
        ? error
        : new UsageLimitSourceError({ detail: "Magpie quota transport failed." }),
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError((error) =>
      isSourceError(error)
        ? error
        : new UsageLimitSourceError({ detail: "Magpie quota request timed out." }),
    ),
  );
  const cards = yield* decodeCards(raw).pipe(
    Effect.mapError(
      () => new UsageLimitSourceError({ detail: "Magpie returned an invalid quota schema." }),
    ),
  );
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const ids = new Set<string>();
  const accounts: UsageLimitSourceAccount[] = [];
  for (const card of cards.data) {
    const id = `${card.provider}:${card.name}`;
    if (ids.has(id))
      return yield* new UsageLimitSourceError({
        detail: "Magpie returned duplicate account identities.",
      });
    ids.add(id);
    const checkedAt = DateTime.formatIso(card.readAt);
    const failure = accountError(card.error);
    const stale =
      now - DateTime.toEpochMillis(card.readAt) > MAX_AGE_MS ||
      DateTime.toEpochMillis(card.readAt) > now + 60_000;
    const unavailable = failure || stale;
    const windows = card.windows.map((window) => ({
      id: window.name,
      kind: (/week|seven_day|^7d$/i.test(window.name)
        ? "weekly"
        : /month/i.test(window.name)
          ? "monthly"
          : /session|rolling|five_hour|^5h$/i.test(window.name)
            ? "session"
            : "other") as "weekly" | "monthly" | "session" | "other",
      label: window.name,
      usedPercent: window.used,
      ...(window.resetsAt ? { resetsAt: DateTime.formatIso(window.resetsAt) } : {}),
    }));
    const session = windows.find((window) => window.kind === "session");
    const weekly = windows.find((window) => window.kind === "weekly");
    const claudeWindow = (window: typeof session) =>
      window ? { utilization: window.usedPercent, resets_at: window.resetsAt ?? null } : null;
    const codexWindow = (window: typeof session) =>
      window
        ? {
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt ? Date.parse(window.resetsAt) / 1000 : null,
          }
        : null;
    const mapped =
      card.provider === "claude"
        ? claudeUsageResponseToLimits({
            checkedAt,
            response: {
              rate_limits_available: true,
              rate_limits: { five_hour: claudeWindow(session), seven_day: claudeWindow(weekly) },
            },
          }).limits
        : card.provider === "codex"
          ? codexRateLimitsToLimits({
              checkedAt,
              snapshot: {
                primary: codexWindow(session),
                secondary: codexWindow(weekly),
              },
            })
          : makeUsageLimits({ checkedAt, windows });
    const usageLimits = unavailable
      ? makeUnavailableUsageLimits({
          checkedAt,
          reason: stale ? "stale" : "probeFailed",
          message: `${failure ?? "Magpie quota data is stale."}${failure && stale ? " Quota data is stale." : ""}`,
        })
      : card.provider === "magpie-go"
        ? mapped
        : makeUsageLimits({
            checkedAt,
            windows: [
              ...mapped.windows,
              ...windows.filter((window) => window.kind === "monthly" || window.kind === "other"),
            ],
          });
    accounts.push({
      id,
      driver: ProviderDriverKind.make(
        card.provider === "claude"
          ? "claudeAgent"
          : card.provider === "codex"
            ? "codex"
            : "opencode",
      ),
      ...(card.user ? { email: card.user } : {}),
      ...(card.plan ? { plan: card.plan } : {}),
      usageLimits,
    });
  }
  return accounts;
});
