// @effect-diagnostics nodeBuiltinImport:off - this suite reads only in-memory strings.
import { assert, it } from "@effect/vitest";

import { openCodeSnapshotsEnabled } from "./launchPreflightConsumer.ts";

it("W2-D: OpenCode inline config is read as the JSONC the provider actually accepts", () => {
  // Ordinary JSON still works.
  assert.strictEqual(openCodeSnapshotsEnabled('{"snapshot":false}'), false);
  assert.strictEqual(openCodeSnapshotsEnabled('{"snapshot":true}'), true);
  // OpenCode v1.18.x loads OPENCODE_CONFIG_CONTENT through a JSONC parser, so
  // comments and trailing commas are valid and `snapshot:false` must be honored.
  assert.strictEqual(
    openCodeSnapshotsEnabled('{\n  // snapshots off for this project\n  "snapshot": false,\n}\n'),
    false,
  );
  assert.strictEqual(openCodeSnapshotsEnabled('{ "snapshot": false, /* trailing */ }'), false);
  // A JSONC config that keeps the default is still the provider default (on).
  assert.strictEqual(openCodeSnapshotsEnabled("{\n  // keep defaults\n}\n"), true);
  assert.strictEqual(openCodeSnapshotsEnabled("{}"), true);
});

it("W2-D: unknown inline configuration is not asserted definitely enabled", () => {
  assert.strictEqual(openCodeSnapshotsEnabled("not json"), "unknown");
  assert.strictEqual(openCodeSnapshotsEnabled('{ "snapshot": false,,, '), "unknown");
  assert.strictEqual(openCodeSnapshotsEnabled("[1, 2, 3]"), "unknown");
  assert.strictEqual(openCodeSnapshotsEnabled('{ "snapshot": "no" }'), "unknown");
});
