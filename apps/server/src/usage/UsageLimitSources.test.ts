import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceEnvironmentVariableName,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { make } from "./UsageLimitSources.ts";

it.effect(
  "aggregates Magpie, clears stale windows, honors removal, and refuses reset requests",
  () =>
    Effect.gen(function* () {
      const keyName = "T3_SYNTHETIC_MAGPIE_QUOTA_TEST";
      // Synthetic env only; production injection is owned by the deployment parent.
      const original = process.env[keyName];
      process.env[keyName] = "synthetic-key";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (original === undefined) delete process.env[keyName];
          else process.env[keyName] = original;
        }),
      );
      let enabled = true;
      let stale = false;
      const sourceId = UsageLimitSourceId.make("syntheticHub");
      const settings = () => ({
        ...DEFAULT_SERVER_SETTINGS,
        usageLimitSources: enabled
          ? {
              [sourceId]: {
                kind: "magpie" as const,
                url: "http://hub.test:3425",
                apiKeyEnv: ProviderInstanceEnvironmentVariableName.make(keyName),
                managementKey: "",
                enabled: true,
              },
            }
          : {},
      });
      const layers = Layer.mergeAll(
        Layer.mock(ServerSettingsService)({
          getSettings: Effect.sync(settings),
          streamChanges: Stream.empty,
        }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("No CLIProxy requests")),
        ),
      );
      let requests = 0;
      const fetch: typeof globalThis.fetch = async () => {
        requests++;
        return Response.json({
          data: [
            {
              provider: "magpie-go",
              name: "synthetic-go",
              kind: "subscription",
              user: null,
              readAt: stale ? "1969-12-31T23:00:00Z" : "1970-01-01T00:00:00Z",
              windows: [{ name: "month", used: 100, remaining: 0 }],
            },
          ],
        });
      };
      const source = yield* make.pipe(
        Effect.provide(layers),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
      const refresh = source.refresh.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
      yield* refresh;
      expect((yield* source.current)[0]?.accounts[0]?.usageLimits.windows[0]?.usedPercent).toBe(
        100,
      );
      const reset = yield* source
        .consumeResetCredit({
          sourceId,
          accountId: "magpie-go:synthetic-go",
          creditId: "synthetic-credit",
        })
        .pipe(Effect.result);
      expect(reset._tag).toBe("Failure");
      stale = true;
      yield* refresh;
      expect((yield* source.current)[0]?.accounts[0]?.usageLimits).toMatchObject({
        windows: [],
        unavailable: { reason: "stale" },
      });
      enabled = false;
      const before = requests;
      yield* refresh;
      expect(yield* source.current).toEqual([]);
      expect(requests).toBe(before);
    }),
);
