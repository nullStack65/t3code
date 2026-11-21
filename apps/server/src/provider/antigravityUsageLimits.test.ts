import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import {
  makeAntigravityUsageProbe,
  parseAntigravityCliCredential,
  type AntigravityCliAccess,
} from "./antigravityUsageLimits.ts";

const summary = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-weekly",
          window: "weekly",
          remainingFraction: 0.96,
          resetTime: "2026-10-12T19:41:43Z",
        },
        {
          bucketId: "gemini-5h",
          window: "5h",
          remainingFraction: 0.91,
          resetTime: "2026-10-09T16:06:01Z",
        },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        {
          bucketId: "3p-weekly",
          window: "weekly",
          remainingFraction: 0,
          resetTime: "2026-10-10T15:28:22Z",
        },
        {
          bucketId: "3p-5h",
          window: "5h",
          remainingFraction: 0.44,
          resetTime: "2026-10-09T16:06:30Z",
        },
      ],
    },
  ],
};

const fixture = Effect.fn("AntigravityUsageTest.fixture")(function* (
  options: {
    summary?: unknown;
    /** Per-host quota summaries; hosts not listed fall back to `summary`. */
    summaryByHost?: Record<string, unknown>;
    models?: unknown;
    summaryStatus?: number;
    /** Per-host summary statuses; hosts not listed fall back to `summaryStatus`. */
    summaryStatusByHost?: Record<string, number>;
    tokenStatus?: number;
    refreshToken?: string;
    userId?: string;
    userInfoAt?: number;
    missingToken?: boolean;
    authMethod?: "oauth-personal" | "oauth-business" | "gemini-api-key";
    /** Uses this bearer and sends no project id. Skips the OAuth refresh call. */
    cliAccess?: AntigravityCliAccess | "expired";
    /** Reads CLI credential files and this secret instead of the real keyring. */
    discover?: boolean;
    readStoredSecret?: Effect.Effect<string | null>;
    directAccess?: string;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profileDirectory = yield* fs.makeTempDirectoryScoped();
  const homeDirectory = yield* fs.makeTempDirectoryScoped();
  yield* fs.makeDirectory(path.join(profileDirectory, "antigravity-acp"));
  const tokenPath = path.join(profileDirectory, "antigravity-acp", "acp_token.json");
  const writeToken = (refreshToken: string) =>
    fs.writeFileString(
      tokenPath,
      JSON.stringify({
        client_id: "client-id",
        client_secret: "client-secret",
        refresh_token: refreshToken,
        project_id: "project-id",
      }),
    );
  const suppliedAccess =
    options.cliAccess && typeof options.cliAccess === "object"
      ? options.cliAccess.accessToken
      : undefined;
  const bearer = suppliedAccess ?? options.directAccess ?? "access-token";
  const quotaBody = suppliedAccess || options.directAccess ? {} : { project: "project-id" };
  if (!options.missingToken && !options.discover && options.cliAccess === undefined) {
    yield* writeToken(options.refreshToken ?? "refresh-a");
  }
  const requests: Array<{ url: string; body: string }> = [];
  const http = HttpClient.make((request, url, _signal, fiber) =>
    Effect.sync(() => {
      const init = Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit);
      expect(init?.redirect).toBe("manual");
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      requests.push({ url: request.url, body });
      if (request.url.endsWith("/token")) {
        expect(new URLSearchParams(body).get("grant_type")).toBe("refresh_token");
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            { access_token: "access-token", expires_in: 3600 },
            { status: options.tokenStatus ?? 200 },
          ),
        );
      }
      expect(request.headers.authorization).toBe(`Bearer ${bearer}`);
      if (request.url.endsWith("/userinfo")) {
        return HttpClientResponse.fromWeb(
          request,
          options.userId
            ? Response.json({ id: options.userId, email: "someone@example.com" })
            : Response.json({}, { status: 403 }),
        );
      }
      expect(JSON.parse(body)).toEqual(quotaBody);
      expect(request.headers["user-agent"]).toMatch(/^antigravity\/hub\/2\.24\.0 /);
      return HttpClientResponse.fromWeb(
        request,
        request.url.endsWith(":retrieveUserQuotaSummary")
          ? Response.json(options.summaryByHost?.[url.host] ?? options.summary ?? summary, {
              status: options.summaryStatusByHost?.[url.host] ?? options.summaryStatus ?? 200,
            })
          : Response.json(options.models ?? { models: {} }),
      );
    }).pipe(
      Effect.tap(() =>
        request.url.endsWith("/userinfo") && options.userInfoAt !== undefined
          ? TestClock.setTime(options.userInfoAt)
          : Effect.void,
      ),
    ),
  );
  const usage = yield* makeAntigravityUsageProbe({
    profileDirectory,
    authMethod: options.authMethod ?? "oauth-personal",
    ...(options.discover
      ? { readStoredSecret: options.readStoredSecret ?? Effect.succeed(null) }
      : { cliAccess: options.cliAccess ?? null }),
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
  );
  return { ...usage, requests, writeToken, tokenPath, profileDirectory, homeDirectory };
});

describe("Antigravity subscription limits", () => {
  // Oracle: the 10:16 UTC payload and its narrow Workaround rule.
  it.effect("omits rolling resets for untouched summary buckets and keeps used Gemini resets", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")));
      const { probe } = yield* fixture({
        summary: {
          groups: [
            {
              buckets: [
                {
                  bucketId: "3p-5h",
                  window: "5h",
                  remainingFraction: 1,
                  resetTime: "2026-10-21T15:16:05Z",
                },
                {
                  bucketId: "3p-weekly",
                  window: "weekly",
                  remainingFraction: 1,
                  resetTime: "2026-10-28T10:16:05Z",
                },
                {
                  bucketId: "gemini-5h",
                  window: "5h",
                  remainingFraction: 0.848104,
                  resetTime: "2026-10-21T13:29:53Z",
                  description:
                    "You have used some of your 5-hour limit, it will fully refresh in 3 hours, 13 minutes.",
                },
                {
                  bucketId: "gemini-weekly",
                  window: "weekly",
                  remainingFraction: 0.9620177,
                  resetTime: "2026-10-28T08:29:53Z",
                  description:
                    "You have used some of your weekly limit, it will fully refresh in 6 days, 22 hours.",
                },
              ],
            },
          ],
        },
      });
      const limits = yield* probe;
      const byId = new Map(limits.windows.map((window) => [window.id, window]));
      expect(byId.get("3p-5h")).toEqual({
        id: "3p-5h",
        label: "Claude & GPT (shared) · 5-hour",
        kind: "session",
        usedPercent: 0,
        windowDurationMins: 300,
      });
      expect(byId.get("3p-weekly")).toEqual({
        id: "3p-weekly",
        label: "Claude & GPT (shared) · Weekly",
        kind: "weekly",
        usedPercent: 0,
        windowDurationMins: 10080,
      });
      expect(byId.get("gemini-5h")?.resetsAt).toBe("2026-10-21T13:29:53.000Z");
      expect(byId.get("gemini-weekly")?.resetsAt).toBe("2026-10-28T08:29:53.000Z");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Oracle: measure the tolerance from the summary request, after auth.
  it.effect("uses summary request time after authentication for the reset tolerance", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:02Z")));
      const { probe } = yield* fixture({
        userInfoAt: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")),
        summary: {
          buckets: [
            {
              bucketId: "3p-5h",
              window: "5h",
              remainingFraction: 1,
              resetTime: "2026-10-21T15:17:03Z",
            },
          ],
        },
      });
      expect((yield* probe).windows[0]?.resetsAt).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Oracle: keep descriptions, measured resets, and spent buckets.
  it.effect("keeps summary resets with a description, a distant reset, or no quota left", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")));
      const { probe } = yield* fixture({
        summary: {
          buckets: [
            {
              bucketId: "described",
              window: "5h",
              remainingFraction: 1,
              description: "Reported reset",
              resetTime: "2026-10-21T15:16:04Z",
            },
            {
              bucketId: "distant",
              window: "weekly",
              remainingFraction: 1,
              resetTime: "2026-10-28T12:16:04Z",
            },
            {
              bucketId: "spent",
              window: "5h",
              remainingFraction: 0,
              resetTime: "2026-10-21T15:16:04Z",
            },
            {
              bucketId: "overfull",
              window: "5h",
              remainingFraction: 1.01,
              resetTime: "2026-10-21T15:16:04Z",
            },
            {
              bucketId: "empty-description",
              window: "5h",
              remainingFraction: 1,
              description: "",
              resetTime: "2026-10-21T15:16:04Z",
            },
          ],
        },
      });
      expect((yield* probe).windows.map(({ id, resetsAt }) => ({ id, resetsAt }))).toEqual([
        { id: "described", resetsAt: "2026-10-21T15:16:04.000Z" },
        { id: "empty-description", resetsAt: "2026-10-21T15:16:04.000Z" },
        { id: "overfull", resetsAt: "2026-10-21T15:16:04.000Z" },
        { id: "spent", resetsAt: "2026-10-21T15:16:04.000Z" },
        { id: "distant", resetsAt: "2026-10-28T12:16:04.000Z" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Oracle: the 60-second tolerance applies to both known window lengths.
  it.effect("omits summary resets 59 seconds away but keeps resets 61 seconds away", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")));
      const { probe } = yield* fixture({
        summary: {
          buckets: [
            {
              bucketId: "5h-before",
              window: "5h",
              remainingFraction: 1,
              resetTime: "2026-10-21T15:15:05Z",
            },
            {
              bucketId: "5h-after",
              window: "5h",
              remainingFraction: 1,
              resetTime: "2026-10-21T15:17:05Z",
            },
            {
              bucketId: "5h-edge",
              window: "5h",
              remainingFraction: 1,
              resetTime: "2026-10-21T15:17:04Z",
            },
            {
              bucketId: "weekly-after",
              window: "weekly",
              remainingFraction: 1,
              resetTime: "2026-10-28T10:17:03Z",
            },
            {
              bucketId: "weekly-before",
              window: "weekly",
              remainingFraction: 1,
              resetTime: "2026-10-28T10:15:03Z",
            },
            {
              bucketId: "weekly-edge",
              window: "weekly",
              remainingFraction: 1,
              resetTime: "2026-10-28T10:15:04Z",
            },
          ],
        },
      });
      expect((yield* probe).windows.map(({ id, resetsAt }) => ({ id, resetsAt }))).toEqual([
        { id: "5h-after", resetsAt: "2026-10-21T15:17:05.000Z" },
        { id: "5h-before", resetsAt: undefined },
        { id: "5h-edge", resetsAt: undefined },
        { id: "weekly-after", resetsAt: undefined },
        { id: "weekly-before", resetsAt: "2026-10-28T10:15:03.000Z" },
        { id: "weekly-edge", resetsAt: undefined },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Oracle: workspace sign-ins are metered on cloudcode-pa, so its reading wins even when less used.
  it.effect("reports a business account's quota from the endpoint it is metered on", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")));
      const { probe } = yield* fixture({
        authMethod: "oauth-business",
        summaryByHost: {
          "daily-cloudcode-pa.googleapis.com": {
            buckets: [
              {
                bucketId: "3p-5h",
                window: "5h",
                remainingFraction: 1,
                resetTime: "2026-10-21T15:16:04Z",
              },
              {
                bucketId: "3p-weekly",
                window: "weekly",
                remainingFraction: 0.5,
                resetTime: "2026-10-27T10:16:04Z",
              },
            ],
          },
          "cloudcode-pa.googleapis.com": {
            buckets: [
              {
                bucketId: "3p-5h",
                window: "5h",
                remainingFraction: 0.5,
                resetTime: "2026-10-21T13:16:04Z",
              },
              {
                bucketId: "3p-weekly",
                window: "weekly",
                remainingFraction: 1,
                resetTime: "2026-10-28T10:16:04Z",
              },
            ],
          },
        },
      });
      expect((yield* probe).windows).toEqual([
        {
          id: "3p-5h",
          label: "Claude & GPT (shared) · 5-hour",
          kind: "session",
          usedPercent: 50,
          windowDurationMins: 300,
          resetsAt: "2026-10-21T13:16:04.000Z",
        },
        {
          id: "3p-weekly",
          label: "Claude & GPT (shared) · Weekly",
          kind: "weekly",
          usedPercent: 0,
          windowDurationMins: 10080,
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Oracle: model quotas have no evidence for the summary-only rule.
  it.effect("keeps full model fallback resets even at a full window from the request", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")));
      const { probe } = yield* fixture({
        summaryStatus: 404,
        models: {
          models: {
            "gemini-a": {
              quotaInfo: { remainingFraction: 1, resetTime: "2026-10-21T15:16:04Z" },
              weeklyQuotaInfo: { remainingFraction: 1, resetTime: "2026-10-28T10:16:04Z" },
            },
          },
        },
      });
      expect(
        (yield* probe).windows.map(({ id, resetsAt, windowDurationMins }) => ({
          id,
          resetsAt,
          windowDurationMins,
        })),
      ).toEqual([
        { id: "gemini-weekly", resetsAt: "2026-10-28T10:16:04.000Z", windowDurationMins: 10080 },
        { id: "gemini-quota", resetsAt: "2026-10-21T15:16:04.000Z", windowDurationMins: undefined },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("reports separate Gemini and shared Claude/GPT five-hour and weekly limits", () =>
    Effect.gen(function* () {
      const { probe, requests } = yield* fixture();
      const limits = yield* probe;
      expect(limits.windows).toHaveLength(4);
      expect(limits.unavailable).toBeUndefined();
      expect(limits.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
      const byId = new Map(limits.windows.map((window) => [window.id, window]));
      expect(byId.get("gemini-weekly")?.usedPercent).toBeCloseTo(4);
      expect(byId.get("gemini-5h")?.usedPercent).toBeCloseTo(9);
      expect(byId.get("3p-weekly")).toMatchObject({
        label: "Claude & GPT (shared) · Weekly",
        kind: "weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
        resetsAt: "2026-10-10T15:28:22.000Z",
      });
      expect(byId.get("3p-5h")).toMatchObject({ kind: "session", windowDurationMins: 300 });
      expect(byId.get("3p-5h")?.usedPercent).toBeCloseTo(56);
      yield* probe;
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(1);
      expect(
        requests.filter((request) => request.url.endsWith(":retrieveUserQuotaSummary")),
      ).toHaveLength(4);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("merges quota groups that only one endpoint reports", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summaryByHost: {
          // The daily endpoint can omit Gemini while the other endpoint returns all groups.
          "daily-cloudcode-pa.googleapis.com": {
            groups: [
              {
                displayName: "Claude and GPT models",
                buckets: [
                  { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.5 },
                  { bucketId: "3p-5h", window: "5h", remainingFraction: 0.3 },
                ],
              },
            ],
          },
        },
      });
      const limits = yield* probe;
      expect(limits.windows.map((window) => window.id).toSorted()).toEqual([
        "3p-5h",
        "3p-weekly",
        "gemini-5h",
        "gemini-weekly",
      ]);
      const byId = new Map(limits.windows.map((window) => [window.id, window]));
      expect(byId.get("gemini-weekly")?.label).toBe("Gemini · Weekly");
      expect(byId.get("3p-5h")?.usedPercent).toBeCloseTo(70);
      expect(byId.get("3p-weekly")?.usedPercent).toBe(50);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Oracle: reported payloads for a personal sign-in, whose runtime meters on the daily endpoint.
  it.effect("reports a personal account's quota from the daily endpoint it is metered on", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-07T12:00:00Z")));
      const argon = (remainingFraction: number, resetTime: string) => ({
        groups: [
          {
            displayName: "Gemini 4 Argon",
            buckets: [
              {
                bucketId: "gemini-argon-wtu-weekly",
                window: "weekly",
                remainingFraction,
                resetTime,
              },
            ],
          },
        ],
      });
      const { probe } = yield* fixture({
        authMethod: "oauth-personal",
        summaryByHost: {
          "daily-cloudcode-pa.googleapis.com": argon(0.8623059, "2026-11-14T08:41:35Z"),
          "cloudcode-pa.googleapis.com": argon(0, "2026-11-08T18:27:14Z"),
        },
      });
      expect((yield* probe).windows).toEqual([
        expect.objectContaining({
          id: "gemini-argon-wtu-weekly",
          usedPercent: expect.closeTo(13.77, 2),
          resetsAt: "2026-11-14T08:41:35.000Z",
        }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("labels Argon and Carbon quotas apart from the default Gemini quota", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summary: {
          groups: [
            ...summary.groups,
            {
              displayName: "Gemini 4 Argon",
              buckets: [
                { bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 0.6 },
              ],
            },
            {
              displayName: "Gemini 4 Carbon",
              buckets: [
                { bucketId: "gemini-carbon-wtu-weekly", window: "weekly", remainingFraction: 0.4 },
              ],
            },
            {
              displayName: " ",
              buckets: [{ bucketId: "gemini-carbon-5h", window: "5h", remainingFraction: 0.8 }],
            },
          ],
        },
      });
      const limits = yield* probe;
      const byId = new Map(limits.windows.map((window) => [window.id, window]));
      expect(byId.get("gemini-weekly")?.label).toBe("Gemini · Weekly");
      expect(byId.get("gemini-argon-wtu-weekly")?.label).toBe("Gemini 4 Argon · Weekly");
      expect(byId.get("gemini-carbon-wtu-weekly")?.label).toBe("Gemini 4 Carbon · Weekly");
      expect(byId.get("gemini-carbon-5h")?.label).toBe("Gemini Carbon · 5-hour");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("keeps one endpoint's quotas when the other fails", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summaryStatusByHost: { "daily-cloudcode-pa.googleapis.com": 503 },
      });
      const limits = yield* probe;
      expect(limits.unavailable).toBeUndefined();
      expect(limits.windows).toHaveLength(4);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("re-reads changed credentials and clears cached access after sign-out", () =>
    Effect.gen(function* () {
      const { probe, clear, requests, writeToken, tokenPath } = yield* fixture();
      const first = yield* probe;
      yield* writeToken("refresh-b");
      const second = yield* probe;
      expect(second.credentialFingerprint).not.toBe(first.credentialFingerprint);
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(2);
      yield* (yield* FileSystem.FileSystem).remove(tokenPath);
      expect((yield* probe).unavailable?.reason).toBe("unsupported");
      yield* writeToken("refresh-b");
      yield* probe;
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(3);
      yield* clear;
      yield* probe;
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(4);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("names one Google account the same way from every sign-in", () =>
    Effect.gen(function* () {
      const read = (refreshToken: string, userId: string) =>
        fixture({ refreshToken, userId }).pipe(Effect.flatMap((usage) => usage.probe));
      const machineA = yield* read("refresh-a", "google-user-1");
      const machineB = yield* read("refresh-b", "google-user-1");
      const otherAccount = yield* read("refresh-c", "google-user-2");
      expect(machineA.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(machineB.credentialFingerprint).toBe(machineA.credentialFingerprint);
      expect(otherAccount.credentialFingerprint).not.toBe(machineA.credentialFingerprint);
      expect(JSON.stringify(machineA)).not.toMatch(/google-user-1|someone@example.com/);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("falls back to model quotas without inventing a window duration", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summaryStatus: 404,
        models: {
          models: {
            "gemini-a": {
              modelProvider: "MODEL_PROVIDER_GOOGLE",
              quotaInfo: { remainingFraction: 0.8, resetTime: "2026-10-10T12:00:00Z" },
            },
            "gemini-b": {
              modelProvider: "MODEL_PROVIDER_GOOGLE",
              quotaInfo: { remainingFraction: 0.6, resetTime: "2026-10-10T12:00:00Z" },
            },
            "claude-a": { quotaInfo: { remainingFraction: 0.2 } },
          },
        },
      });
      const limits = yield* probe;
      expect(limits.windows).toHaveLength(2);
      expect(limits.windows.find((window) => window.id === "gemini-quota")?.usedPercent).toBe(40);
      expect(
        limits.windows.every(
          (window) => window.kind === "other" && window.windowDurationMins === undefined,
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("skips disabled and missing fractions and clamps valid percentages", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summary: {
          buckets: [
            { bucketId: "disabled", remainingFraction: 0, disabled: true },
            { bucketId: "missing", resetTime: "2026-10-10T12:00:00Z" },
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 2, resetTime: "invalid" },
          ],
        },
      });
      expect((yield* probe).windows).toEqual([
        {
          id: "gemini-5h",
          kind: "session",
          label: "Gemini · 5-hour",
          usedPercent: 0,
          windowDurationMins: 300,
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("returns a safe failure when OAuth refresh fails", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({ tokenStatus: 401 });
      const limits = yield* probe;
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(JSON.stringify(limits)).not.toMatch(/client-secret|refresh-a|access-token/);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("does not make network requests for API keys or missing sign-ins", () =>
    Effect.gen(function* () {
      const apiKey = yield* fixture({ authMethod: "gemini-api-key" });
      const apiLimits = yield* apiKey.probe;
      expect(apiLimits.unavailable).toEqual({
        reason: "unsupported",
        message:
          "Not applicable: Antigravity API keys and Agent Platform are billed by Google. T3 has no quota window for them.",
      });
      expect(apiKey.requests).toEqual([]);
      const signedOut = yield* fixture({ missingToken: true });
      const signedOutLimits = yield* signedOut.probe;
      expect(signedOutLimits.unavailable).toEqual({
        reason: "unsupported",
        message: "Sign in with Google to see limits.",
      });
      expect(signedOut.requests).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it("parses the keyring credential agy stores, including a nanosecond expiry", () => {
    const now = Date.parse("2026-11-20T12:00:00.000Z");
    expect(
      parseAntigravityCliCredential(
        JSON.stringify({
          token: {
            access_token: "access",
            refresh_token: "refresh",
            expiry: "2026-11-20T19:22:44.180377856Z",
          },
        }),
        now,
      ),
    ).toEqual({
      accessToken: "access",
      identity: "refresh",
      expiresAtMs: Date.parse("2026-11-20T19:22:44.180Z"),
    });
    expect(parseAntigravityCliCredential(JSON.stringify({ access_token: "flat" }), now)).toEqual({
      accessToken: "flat",
      identity: "flat",
    });
    expect(
      parseAntigravityCliCredential(
        JSON.stringify({ token: { access_token: "old", expiry: "2026-11-20T11:00:00Z" } }),
        now,
      ),
    ).toBe("expired");
    expect(parseAntigravityCliCredential("{", now)).toBeUndefined();
    expect(parseAntigravityCliCredential("{}", now)).toBeUndefined();
  });

  it.effect("uses a saved Antigravity access token without calling the token endpoint", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-20T12:00:00Z")));
      const { probe, requests } = yield* fixture({
        missingToken: true,
        userId: "google-user-9",
        cliAccess: {
          accessToken: "cli-access-token",
          identity: "cli-refresh-token",
          expiresAtMs: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-20T13:00:00Z")),
        },
      });
      const limits = yield* probe;
      expect(limits.unavailable).toBeUndefined();
      expect(limits.windows.some((window) => window.id === "gemini-5h")).toBe(true);
      expect(requests.some((request) => request.url.endsWith("/token"))).toBe(false);
      expect(limits.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(limits)).not.toMatch(/cli-access-token|cli-refresh-token/);
      yield* probe;
      expect(requests.filter((request) => request.url.endsWith("/userinfo"))).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("re-reads an access token once its unknown expiry cache elapses", () =>
    Effect.gen(function* () {
      const { probe, requests } = yield* fixture({
        missingToken: true,
        cliAccess: { accessToken: "cli-access-token", identity: "cli-refresh-token" },
      });
      yield* probe;
      yield* TestClock.adjust("6 minutes");
      yield* probe;
      expect(requests.filter((request) => request.url.endsWith("/userinfo"))).toHaveLength(2);
      expect(requests.some((request) => request.url.endsWith("/token"))).toBe(false);
      expect(JSON.stringify(yield* probe)).not.toMatch(/cli-access-token|cli-refresh-token/);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("does not send a lapsed Antigravity access token", () =>
    Effect.gen(function* () {
      const { probe, requests } = yield* fixture({ missingToken: true, cliAccess: "expired" });
      const limits = yield* probe;
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable).toEqual({
        reason: "probeFailed",
        message:
          "Antigravity's saved access token has lapsed. A running agy session refreshes it; the Antigravity app does not need to be open.",
      });
      expect(requests).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("reads the profile OAuth file and does not open the keyring", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-20T12:00:00Z")));
      const { probe, requests, profileDirectory } = yield* fixture({
        discover: true,
        directAccess: "file-access-token",
        readStoredSecret: Effect.die("keyring should stay unread"),
      });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(profileDirectory, "antigravity-acp", "antigravity-oauth-token"),
        JSON.stringify({
          token: {
            access_token: "file-access-token",
            refresh_token: "file-refresh-token",
            expiry: "2026-11-20T19:22:44.180377856Z",
          },
        }),
      );
      const limits = yield* probe;
      expect(limits.unavailable).toBeUndefined();
      expect(requests.some((request) => request.url.endsWith("/token"))).toBe(false);
      expect(JSON.stringify(limits)).not.toMatch(/file-access-token|file-refresh-token/);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("uses a fresh home credential when the profile credential has lapsed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-20T12:00:00Z")));
      const { probe, profileDirectory, homeDirectory } = yield* fixture({
        discover: true,
        directAccess: "home-access-token",
        readStoredSecret: Effect.die("keyring should stay unread"),
      });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(profileDirectory, "antigravity-oauth-token"),
        JSON.stringify({
          token: { access_token: "old-access-token", expiry: "2020-01-01T00:00:00Z" },
        }),
      );
      const directory = path.join(homeDirectory, ".gemini", "antigravity-cli");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "antigravity-oauth-token"),
        JSON.stringify({
          access_token: "home-access-token",
          refresh_token: "home-refresh-token",
          expiry: "2099-01-01T00:00:00Z",
        }),
      );
      const limits = yield* probe;
      expect(limits.unavailable).toBeUndefined();
      expect(JSON.stringify(limits)).not.toMatch(
        /old-access-token|home-access-token|home-refresh-token/,
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("uses the keyring access token when no credential file exists", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-20T12:00:00Z")));
      const { probe, requests } = yield* fixture({
        discover: true,
        directAccess: "keyring-access-token",
        readStoredSecret: Effect.succeed(
          JSON.stringify({
            token: {
              access_token: "keyring-access-token",
              refresh_token: "keyring-refresh-token",
              expiry: "2026-11-20T19:22:44.180377856Z",
            },
          }),
        ),
      });
      const limits = yield* probe;
      expect(limits.windows.some((window) => window.id === "gemini-weekly")).toBe(true);
      expect(requests.some((request) => request.url.endsWith("/token"))).toBe(false);
      expect(JSON.stringify(limits)).not.toMatch(/keyring-access-token|keyring-refresh-token/);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("reports a lapsed keyring token without sending it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-20T12:00:00Z")));
      const { probe, requests } = yield* fixture({
        discover: true,
        readStoredSecret: Effect.succeed(
          JSON.stringify({
            token: { access_token: "lapsed-access-token", expiry: "2020-01-01T00:00:00Z" },
          }),
        ),
      });
      const limits = yield* probe;
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(requests).toEqual([]);
      expect(JSON.stringify(limits)).not.toMatch(/lapsed-access-token/);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("asks for model quotas when the summary is only untouched placeholders", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")));
      const { probe, requests } = yield* fixture({
        summary: {
          groups: [
            {
              displayName: "Claude and GPT models",
              buckets: [
                {
                  bucketId: "3p-5h",
                  window: "5h",
                  remainingFraction: 1,
                  resetTime: "2026-10-21T15:16:05Z",
                },
                {
                  bucketId: "3p-weekly",
                  window: "weekly",
                  remainingFraction: 1,
                  resetTime: "2026-10-28T10:16:05Z",
                },
              ],
            },
          ],
        },
        models: {
          models: {
            "gemini-a": {
              modelProvider: "MODEL_PROVIDER_GOOGLE",
              quotaInfo: { remainingFraction: 0.74, resetTime: "2026-10-21T13:40:58Z" },
            },
          },
        },
      });
      const limits = yield* probe;
      expect(limits.windows.map((window) => window.id)).toEqual(["gemini-quota"]);
      expect(limits.windows[0]?.usedPercent).toBeCloseTo(26, 5);
      expect(requests.some((request) => request.url.endsWith(":fetchAvailableModels"))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
