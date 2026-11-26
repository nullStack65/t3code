import { useAtomValue } from "@effect/atom-react";
import { PRIMARY_LOCAL_ENVIRONMENT_ID, type Founder } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import {
  updateClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
} from "../hooks/useSettings";
import { environmentIdsKey } from "./environmentAtomList";
import { environmentSummaries } from "./presentation";
import { environmentSessionStatesAtom } from "./session";

/**
 * Seeds `founderInboxOwner` once on fresh clients (such as a mobile browser authenticated via
 * Cloudflare Access) from the authenticated session's `founder`. Waits for client settings to
 * hydrate first so an explicit saved choice is never overwritten.
 */
export function AutoSeedFounderInboxOwner() {
  const hydrated = useClientSettingsHydrated();
  const founderInboxOwner = useClientSettings((settings) => settings.founderInboxOwner);
  const identities = useAtomValue(environmentSummaries.identitiesAtom);
  const states = useAtomValue(
    environmentSessionStatesAtom(
      environmentIdsKey(identities.map((identity) => identity.environmentId)),
    ),
  );
  let sessionFounder: Founder | undefined;
  for (let i = 0; i < states.length; i++) {
    const session = AsyncResult.getOrElse(states[i]!, () => null);
    if (!session?.authenticated || session.founder === undefined) continue;
    if (identities[i]?.environmentId === PRIMARY_LOCAL_ENVIRONMENT_ID) {
      sessionFounder = session.founder;
      break;
    }
    sessionFounder ??= session.founder;
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- seeds founderInboxOwner once when unset after settings hydrate
  useEffect(() => {
    if (!hydrated || founderInboxOwner !== undefined || sessionFounder === undefined) return;
    void updateClientSettings({ founderInboxOwner: sessionFounder });
  }, [hydrated, founderInboxOwner, sessionFounder]);
  return null;
}
