import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  openCodeSnapshotsEnabled,
  resolveLaunchPreflightConsumer,
} from "./launchPreflightConsumer.ts";

const opencode = ProviderDriverKind.make("opencode");

it.effect("W1-D: honors inline JSONC without comments or trailing commas misreading", () =>
  Effect.gen(function* () {
    // Strict JSON still works.
    assert.strictEqual(openCodeSnapshotsEnabled('{"snapshot":false}'), false);
    assert.strictEqual(openCodeSnapshotsEnabled('{"snapshot":true}'), true);
    assert.strictEqual(openCodeSnapshotsEnabled("{}"), true);

    // Valid JSONC (open comment, line comment, trailing commas) disables it.
    assert.strictEqual(
      openCodeSnapshotsEnabled('{\n  /* disable staging */\n  "snapshot": false,\n}\n'),
      false,
    );
    assert.strictEqual(openCodeSnapshotsEnabled('{\n  // comment\n  "snapshot": false,\n}'), false);
    assert.strictEqual(openCodeSnapshotsEnabled('{ "snapshot": true, }'), true);
  }),
);

it.effect("W1-D: unknown configuration is never asserted enabled", () =>
  Effect.gen(function* () {
    assert.strictEqual(openCodeSnapshotsEnabled("not json at all"), undefined);
    assert.strictEqual(openCodeSnapshotsEnabled('{"snapshot":'), undefined);
    assert.strictEqual(openCodeSnapshotsEnabled("[]"), undefined);
    assert.strictEqual(openCodeSnapshotsEnabled('"a string"'), undefined);
    // A non-boolean snapshot value is not a definite enable.
    assert.strictEqual(openCodeSnapshotsEnabled('{"snapshot":"off"}'), undefined);
  }),
);

it.effect("W1-D: production settings resolve JSONC snapshot:false to a disabled consumer", () =>
  Effect.gen(function* () {
    const consumer = resolveLaunchPreflightConsumer({
      provider: opencode,
      providerInstanceId: ProviderInstanceId.make("opencode"),
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          opencode: {
            driver: opencode,
            enabled: true,
            environment: [
              {
                name: "OPENCODE_CONFIG_CONTENT",
                value: '{ /* snapshots off */ "snapshot": false, }',
                sensitive: false,
              },
            ],
          },
        },
      },
      hostEnv: {},
    });

    assert.deepStrictEqual(consumer, { driver: "opencode", snapshotsEnabled: false });
  }),
);

it.effect("W1-D: the ordinary default keeps snapshots enabled", () =>
  Effect.gen(function* () {
    const consumer = resolveLaunchPreflightConsumer({
      provider: opencode,
      providerInstanceId: ProviderInstanceId.make("opencode"),
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          opencode: { driver: opencode, enabled: true },
        },
      },
      hostEnv: {},
    });

    assert.deepStrictEqual(consumer, { driver: "opencode", snapshotsEnabled: true });
  }),
);
