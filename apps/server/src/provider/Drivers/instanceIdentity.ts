import type {
  ProviderDriverKind,
  ProviderInstanceConfig,
  ServerProvider,
} from "@t3tools/contracts";

import { makeUnavailableUsageLimits } from "../providerUsageLimits.ts";

import type { ProviderInstance } from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

/**
 * Stamp instance identity onto a `ServerProvider` snapshot produced by the
 * driver-kind-only snapshot helpers. Every driver builds its snapshot without
 * knowing its own instance, so it pipes the draft through this stamper before
 * publishing. Once `buildServerProvider` in `providerSnapshot.ts` is widened to
 * accept `instanceId`/`driver`, this wrapper disappears.
 */
export const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly driverKind: ProviderDriverKind;
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
    readonly usageSource?: ProviderInstanceConfig["usageSource"];
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    ...(input.usageSource
      ? {
          usageLimits: makeUnavailableUsageLimits({
            checkedAt: snapshot.checkedAt,
            reason: "unsupported",
            message: "Usage is reported by the configured billing source.",
          }),
        }
      : {}),
    instanceId: input.instanceId,
    driver: input.driverKind,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });
