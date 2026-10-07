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

it.effect("W1-D: JSONC markers inside strings and escaped characters never alter detection", () =>
  Effect.gen(function* () {
    // Comment markers inside a quoted value are data, not syntax.
    assert.strictEqual(
      openCodeSnapshotsEnabled('{"note":"// not a comment","snapshot":false}'),
      false,
    );
    assert.strictEqual(
      openCodeSnapshotsEnabled('{"note":"/* not a block comment */","snapshot":true}'),
      true,
    );
    // Bracket/comma markers inside a string must not be read as trailing commas.
    assert.strictEqual(openCodeSnapshotsEnabled('{"note":"a, ] } ,","snapshot":false}'), false);
    // Escaped quotes and a trailing escaped backslash.
    assert.strictEqual(
      openCodeSnapshotsEnabled('{"note":"a \\"quoted\\" value","snapshot":false}'),
      false,
    );
    assert.strictEqual(
      openCodeSnapshotsEnabled('{"note":"ends with a backslash \\\\","snapshot":true}'),
      true,
    );
  }),
);

it.effect("W1-D: comments and trailing commas combine with in-string markers", () =>
  Effect.gen(function* () {
    const config = [
      "{",
      '  // keep the "snapshot" key addressable',
      '  "note": "/* not a comment */ and a trailing comma , }",',
      "  /* block comment */",
      '  "snapshot": false,',
      "}",
    ].join("\n");
    assert.strictEqual(openCodeSnapshotsEnabled(config), false);

    // A trailing comma after a value whose string ends in a backslash.
    assert.strictEqual(openCodeSnapshotsEnabled('{"snapshot": true,\n}'), true);
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
    // A malformed document is unknown, never a best-effort partial read.
    assert.strictEqual(openCodeSnapshotsEnabled('{"snapshot":false,} trailing'), undefined);
    assert.strictEqual(openCodeSnapshotsEnabled("{ /* unterminated"), undefined);
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
          [ProviderInstanceId.make("opencode")]: {
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
          [ProviderInstanceId.make("opencode")]: { driver: opencode, enabled: true },
        },
      },
      hostEnv: {},
    });

    assert.deepStrictEqual(consumer, { driver: "opencode", snapshotsEnabled: true });
  }),
);
