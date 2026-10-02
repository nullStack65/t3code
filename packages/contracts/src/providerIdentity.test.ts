import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  compareManagedProviderLaunchIdentity,
  ManagedProviderLaunchIdentity,
  qualifyManagedProviderLaunch,
} from "./providerIdentity.ts";
import { ServerProvider } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const host = { environmentId: "env-a", providerInstanceId: "codex" } as const;
const keyIds = [{ namespace: "provider.example", id: "key-a" }] as const;
const identity = {
  subject: "subject-a",
  keyIds: [...keyIds],
  providerHostInstance: host,
} satisfies typeof ManagedProviderLaunchIdentity.Type;

describe("managed provider launch identity", () => {
  it("keeps old provider snapshots compatible when optional identity fields are absent", () => {
    const provider = decodeServerProvider({
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

  it("does not collide on embedded NULs and normalizes duplicate IDs", () => {
    const first = {
      ...identity,
      keyIds: [
        { namespace: "a\u0000b", id: "c" },
        { namespace: "a\u0000b", id: "c" },
      ],
    };
    const second = {
      ...identity,
      keyIds: [{ namespace: "a", id: "b\u0000c" }],
    };
    expect(compareManagedProviderLaunchIdentity(first, second)).toBe("key-id-drift");
    expect(qualifyManagedProviderLaunch(first).qualified).toBe(true);
    if (qualifyManagedProviderLaunch(first).qualified) {
      expect(qualifyManagedProviderLaunch(first).identity.keyIds).toHaveLength(1);
    }
  });
});
