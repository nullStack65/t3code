import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { stampProviderHostInstance } from "./ProviderRegistry.ts";

describe("provider host identity stamping", () => {
  it("uses the persisted environment plus instance and never continuation metadata", () => {
    const provider = {
      instanceId: ProviderInstanceId.make("codex_work"),
      continuation: { groupKey: "codex:home:/shared" },
    } as ServerProvider;
    assert.deepStrictEqual(stampProviderHostInstance(provider, EnvironmentId.make("env-a")), {
      ...provider,
      providerHostInstance: {
        environmentId: EnvironmentId.make("env-a"),
        providerInstanceId: ProviderInstanceId.make("codex_work"),
      },
    });
  });
});
