import { expect, it } from "@effect/vitest";
import {
  CodexSettings,
  OpenCodeSettings,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  UsageLimitSourceId,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  collectLimitNotices,
  withUsageLimitsCommands,
} from "@t3tools/shared/usageLimits";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { withInstanceIdentity } from "../Drivers/instanceIdentity.ts";
import { makePendingCodexProvider } from "./CodexProvider.ts";
import { makePendingOpenCodeProvider } from "./OpenCodeProvider.ts";

const checkedAt = "2026-09-03T11:00:00.000Z";
const limits = {
  checkedAt,
  windows: [{ id: "five_hour", kind: "session" as const, label: "Session", usedPercent: 40 }],
};
const source = {
  id: UsageLimitSourceId.make("billing"),
  kind: "magpie" as const,
  label: "Magpie",
  checkedAt,
  accounts: [
    { id: "claude:synthetic", driver: ProviderDriverKind.make("claudeAgent"), usageLimits: limits },
    { id: "magpie-go:synthetic", driver: ProviderDriverKind.make("opencode"), usageLimits: limits },
    { id: "codex:unrelated", driver: ProviderDriverKind.make("codex"), usageLimits: limits },
  ],
};
const wire = Schema.fromJsonString(ServerProvider);
const encode = Schema.encodeSync(wire);
const decode = Schema.decodeUnknownSync(wire);
const codexSettings = Schema.decodeUnknownSync(CodexSettings);
const openCodeSettings = Schema.decodeUnknownSync(OpenCodeSettings);

const snapshot = Effect.fn(function* (driver: "codex" | "opencode", accountId: string) {
  const draft =
    driver === "codex"
      ? yield* makePendingCodexProvider(codexSettings({ enabled: true }))
      : yield* makePendingOpenCodeProvider(openCodeSettings({ enabled: true }));
  return decode(
    encode(
      withInstanceIdentity({
        instanceId: ProviderInstanceId.make(`synthetic-${driver}`),
        driverKind: ProviderDriverKind.make(driver),
        displayName: "Unrelated display name",
        accentColor: undefined,
        continuationGroupKey: "synthetic",
        usageSource: { sourceId: source.id, accountId },
      })(draft),
    ),
  );
});

for (const [driver, accountId, billingDriver] of [
  ["codex", "magpie-go:synthetic", "opencode"],
  ["opencode", "claude:synthetic", "claudeAgent"],
] as const) {
  it.effect(
    `resolves ${driver} snapshot through the wire to exactly its ${billingDriver} billing account`,
    () =>
      Effect.gen(function* () {
        const bound = yield* snapshot(driver, accountId);
        expect(bound.driver).toBe(driver);
        expect(bound.usageSource).toEqual({ sourceId: "billing", accountId });
        expect(bound.usageLimits?.windows).toEqual([]);
        const { usageSource, ...unbound } = bound;
        expect(usageSource).toBeDefined();
        const unrelated = {
          ...unbound,
          instanceId: ProviderInstanceId.make("unbound-local"),
          usageLimits: limits,
        };
        const report = collectProviderUsageLimits(
          bound.instanceId,
          [bound, unrelated],
          [source],
          0,
        );
        expect(report?.accounts).toHaveLength(1);
        expect(report?.accounts[0]).toMatchObject({
          id: `billing:${accountId}`,
          driver: billingDriver,
          sourceLabel: "Magpie",
          limits,
        });
        expect(report?.accounts[0]?.resetCreditInput).toBeUndefined();
        expect(report?.notices).toEqual([]);
        expect(
          withUsageLimitsCommands([bound], [])[0]?.slashCommands.some(
            (command) => command.name === "usage-limits",
          ),
        ).toBe(true);
      }),
  );
}

const brokenSources: ReadonlyArray<{ name: string; sources: UsageLimitSourceSnapshots }> = [
  { name: "deleted or disabled source", sources: [] },
  { name: "source ID mismatch", sources: [{ ...source, id: UsageLimitSourceId.make("other") }] },
  {
    name: "account ID mismatch",
    sources: [
      {
        ...source,
        accounts: source.accounts.filter((account) => account.id !== "magpie-go:synthetic"),
      },
    ],
  },
  {
    name: "account belongs to a different source",
    sources: [
      { ...source, accounts: [] },
      { ...source, id: UsageLimitSourceId.make("other") },
    ],
  },
  {
    name: "source entitlement error",
    sources: [{ ...source, accounts: [], error: "Magpie quota request failed (HTTP 403)." }],
  },
  { name: "duplicate source", sources: [source, source] },
  {
    name: "duplicate account",
    sources: [{ ...source, accounts: [...source.accounts, source.accounts[1]!] }],
  },
];
for (const fixture of brokenSources) {
  it.effect(
    `reports a binding failure without native or other-account fallback: ${fixture.name}`,
    () =>
      Effect.gen(function* () {
        const bound = yield* snapshot("codex", "magpie-go:synthetic");
        const { usageSource, ...unbound } = bound;
        expect(usageSource).toBeDefined();
        const unrelated = {
          ...unbound,
          instanceId: ProviderInstanceId.make("unbound-local"),
          usageLimits: limits,
        };
        const report = collectProviderUsageLimits(
          bound.instanceId,
          [bound, unrelated],
          fixture.sources,
          0,
        );
        expect(report?.accounts).toEqual([]);
        expect(report?.notices).toHaveLength(1);
        expect(report?.notices[0]).toContain("Configured billing");
        const notices = collectLimitNotices(
          new Map([
            [
              EnvironmentId.make("fixture"),
              {
                entry: { target: { label: "Synthetic" } },
                serverConfig: {
                  providers: [{ ...bound, enabled: true, installed: true }],
                  usageLimitSources: fixture.sources,
                },
              },
            ],
          ]),
        );
        expect(notices.some((notice) => notice.includes("Configured billing"))).toBe(true);
      }),
  );
}

it.effect("preserves the bound account's stale error instead of selecting a healthy neighbor", () =>
  Effect.gen(function* () {
    const bound = yield* snapshot("opencode", "claude:synthetic");
    const unavailable = {
      checkedAt,
      windows: [],
      unavailable: {
        reason: "stale" as const,
        message: "Magpie account subscription has lapsed. Quota data is stale.",
      },
    };
    const sources = [
      {
        ...source,
        accounts: source.accounts.map((account) =>
          account.id === "claude:synthetic" ? { ...account, usageLimits: unavailable } : account,
        ),
      },
    ];
    const report = collectProviderUsageLimits(bound.instanceId, [bound], sources, 0);
    expect(report?.accounts).toHaveLength(1);
    expect(report?.accounts[0]?.limits).toEqual(unavailable);
    expect(report?.notices[0]).toContain(
      "subscription has lapsed. Quota data is stale. Last read: 2026-09-03T11:00:00.000Z.",
    );
  }),
);
