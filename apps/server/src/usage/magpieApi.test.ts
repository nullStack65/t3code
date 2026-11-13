import { expect, it } from "@effect/vitest";
import { ProviderInstanceEnvironmentVariableName } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/unstable/http";

import { readMagpieAccounts } from "./magpieApi.ts";

const config = {
  kind: "magpie",
  url: "http://hub.test:3425",
  enabled: true,
  managementKey: "",
  apiKeyEnv: ProviderInstanceEnvironmentVariableName.make("MAGPIE_QUOTA_KEY"),
} as const;
const environment = { MAGPIE_QUOTA_KEY: "synthetic-key" };
const card = {
  provider: "claude",
  name: "synthetic-claude",
  kind: "subscription",
  user: "synthetic@example.test",
  readAt: "1970-01-01T00:00:00Z",
  windows: [{ name: "5h", used: 60, remaining: 40 }],
};
const read = (body: unknown) =>
  readMagpieAccounts(config, environment).pipe(
    Effect.provideService(FetchHttpClient.Fetch, async () => Response.json(body)),
  );

it.effect(
  "reads the supported endpoint with an env key, no redirect, and preserves vendor identity",
  () =>
    Effect.gen(function* () {
      const accounts = yield* readMagpieAccounts(config, environment).pipe(
        Effect.provideService(FetchHttpClient.Fetch, async (url, init) => {
          expect(String(url)).toBe("http://hub.test:3425/v1/magpie/quotas");
          expect(init).toMatchObject({
            method: "GET",
            redirect: "manual",
            headers: { Authorization: "Bearer synthetic-key" },
          });
          return Response.json({
            data: [
              card,
              { ...card, provider: "codex", name: "synthetic-codex", plan: "Pro" },
              {
                ...card,
                provider: "magpie-go",
                name: "synthetic-go",
                windows: [{ name: "month", used: 100, remaining: 0 }],
              },
            ],
          });
        }),
      );
      expect(accounts.map((account) => account.driver)).toEqual([
        "claudeAgent",
        "codex",
        "opencode",
      ]);
      expect(accounts.map((account) => account.id)).toEqual([
        "claude:synthetic-claude",
        "codex:synthetic-codex",
        "magpie-go:synthetic-go",
      ]);
      expect(accounts[0]?.usageLimits.windows[0]).toMatchObject({
        id: "five_hour",
        usedPercent: 60,
      });
      expect(accounts[1]?.usageLimits.windows[0]).toMatchObject({ id: "primary", usedPercent: 60 });
      expect(accounts[2]?.usageLimits.windows[0]).toMatchObject({
        kind: "monthly",
        usedPercent: 100,
      });
      expect(accounts.every((account) => account.usageLimits.resetCredits === undefined)).toBe(
        true,
      );
    }),
);

for (const error of ["no-subscription", "PaymentRequired", "lapsed", "signedout"]) {
  it.effect(`preserves ${error} as an account failure without publishing cached windows`, () =>
    Effect.gen(function* () {
      const accounts = yield* read({ data: [{ ...card, error }] });
      expect(accounts[0]?.usageLimits).toMatchObject({
        windows: [],
        unavailable: { reason: "probeFailed" },
      });
      expect(accounts[0]?.usageLimits.unavailable?.message?.toLowerCase()).toContain(
        error === "no-subscription"
          ? "no subscription"
          : error === "signedout"
            ? "signed out"
            : error.toLowerCase(),
      );
    }),
  );
}

it.effect("marks an old read distinctly and retains its observed timestamp and account error", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 hour");
    const accounts = yield* read({ data: [{ ...card, error: { code: "signedout" } }] });
    expect(accounts[0]?.usageLimits).toMatchObject({
      checkedAt: "1970-01-01T00:00:00.000Z",
      windows: [],
      unavailable: {
        reason: "stale",
        message: "Magpie account is signed out. Quota data is stale.",
      },
    });
  }),
);

for (const status of [302, 401, 402, 403, 500]) {
  it.effect(`keeps HTTP ${status} distinct and never forwards a vendor error body`, () =>
    Effect.gen(function* () {
      let requests = 0;
      const result = yield* readMagpieAccounts(config, environment).pipe(
        Effect.provideService(FetchHttpClient.Fetch, async () => {
          requests++;
          return new Response("private-vendor-auth-body", {
            status,
            headers: { Location: "http://other.test/steal" },
          });
        }),
        Effect.result,
      );
      expect(requests).toBe(1);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.detail).toContain(status === 302 ? "redirect" : `HTTP ${status}`);
        expect(result.failure.detail).not.toContain("private-vendor");
      }
    }),
  );
}

for (const data of [
  [{ ...card, provider: "unknown" }],
  [{ ...card, readAt: "not-a-date" }],
  [{ ...card, windows: [{ name: "5h", used: 101, remaining: -1 }] }],
  [card, card],
]) {
  it.effect("rejects malformed or ambiguous cards instead of showing healthy quota", () =>
    Effect.gen(function* () {
      const result = yield* read({ data }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  );
}

it.effect("does not fall back to local credentials when the env reference is missing", () =>
  Effect.gen(function* () {
    const result = yield* readMagpieAccounts(config, {}).pipe(
      Effect.provideService(FetchHttpClient.Fetch, async () => {
        throw new Error("must not request");
      }),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.detail).toContain("environment variable");
  }),
);

it.effect("bounds response size and never echoes unknown account errors", () =>
  Effect.gen(function* () {
    const oversized = yield* readMagpieAccounts(config, environment).pipe(
      Effect.provideService(
        FetchHttpClient.Fetch,
        async () => new Response("x".repeat(256 * 1024 + 1)),
      ),
      Effect.result,
    );
    expect(oversized._tag === "Failure" && oversized.failure.detail).toContain("size limit");
    const accounts = yield* read({ data: [{ ...card, error: "private-key-in-vendor-body" }] });
    expect(accounts[0]?.usageLimits.unavailable?.message).toBe("Magpie reported an account error.");
  }),
);

it.effect("bounds a hanging request and aborts it without a retry", () =>
  Effect.gen(function* () {
    let aborted = false;
    const fiber = yield* readMagpieAccounts(config, environment).pipe(
      Effect.provideService(
        FetchHttpClient.Fetch,
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
      ),
      Effect.result,
      Effect.forkChild,
    );
    yield* TestClock.adjust("11 seconds");
    const result = yield* Fiber.join(fiber);
    expect(result._tag === "Failure" && result.failure.detail).toContain("timed out");
    expect(aborted).toBe(true);
  }),
);
