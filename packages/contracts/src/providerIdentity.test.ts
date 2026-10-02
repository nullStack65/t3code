import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  compareManagedProviderLaunchIdentity,
  ManagedProviderLaunchIdentity,
  qualifyManagedProviderLaunch,
} from "./providerIdentity.ts";
import { ServerProvider } from "./server.ts";

const host = { environmentId: "env-a", providerInstanceId: "codex" } as const;
const keyIds = [{ namespace: "provider.example", id: "key-a" }] as const;
const identity = {
  subject: "subject-a",
  keyIds: [...keyIds],
  providerHostInstance: host,
} satisfies typeof ManagedProviderLaunchIdentity.Type;

describe("managed provider launch identity", () => {
  it("keeps old provider snapshots compatible when optional identity fields are absent", () => {
    const provider = Schema.decodeUnknownSync(ServerProvider)({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
    });
    expect(provider.auth.keyIds).toBeUndefined();
    expect(provider.providerHostInstance).toBeUndefined();
  });

  it("fails closed when any managed-launch component is unavailable", () => {
    expect(qualifyManagedProviderLaunch({ keyIds, providerHostInstance: host })).toEqual({
      qualified: false,
      reason: "missing-subject",
    });
    expect(
      qualifyManagedProviderLaunch({ subject: "subject-a", providerHostInstance: host }),
    ).toEqual({
      qualified: false,
      reason: "missing-key-id",
    });
    expect(qualifyManagedProviderLaunch({ subject: "subject-a", keyIds })).toEqual({
      qualified: false,
      reason: "missing-host-identity",
    });
  });

  it("compares namespace-qualified key sets and reports exact drift", () => {
    expect(compareManagedProviderLaunchIdentity(identity, identity)).toBe("match");
    expect(
      compareManagedProviderLaunchIdentity(identity, { ...identity, subject: "subject-b" }),
    ).toBe("subject-drift");
    expect(
      compareManagedProviderLaunchIdentity(identity, {
        ...identity,
        keyIds: [{ namespace: "provider.example", id: "key-b" }],
      }),
    ).toBe("key-id-drift");
    expect(
      compareManagedProviderLaunchIdentity(identity, {
        ...identity,
        providerHostInstance: { ...host, environmentId: "env-b" },
      }),
    ).toBe("host-drift");
    expect(compareManagedProviderLaunchIdentity(identity, undefined)).toBe("unknown-identity");
  });
});
