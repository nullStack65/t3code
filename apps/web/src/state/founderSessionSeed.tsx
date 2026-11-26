import { useAtomValue } from "@effect/atom-react";
import type { Founder } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import { updateClientSettings, useClientSettings } from "../hooks/useSettings";
import { environmentIdsKey } from "./environmentAtomList";
import { environmentSummaries } from "./presentation";
import { environmentSessionStatesAtom } from "./session";

/**
 * Seeds `founderInboxOwner` once on fresh clients (such as a mobile browser authenticated via
 * Cloudflare Access) from the authenticated session's `founder`. Never overwrites an explicit
 * setting already chosen by the user.
 */
export function AutoSeedFounderInboxOwner() {
  const founderInboxOwner = useClientSettings((settings) => settings.founderInboxOwner);
  const identities = useAtomValue(environmentSummaries.identitiesAtom);
  const states = useAtomValue(
    environmentSessionStatesAtom(
      environmentIdsKey(identities.map((identity) => identity.environmentId)),
    ),
  );
  let sessionFounder: Founder | undefined;
  for (const state of states) {
    const session = AsyncResult.getOrElse(state, () => null);
    if (session?.authenticated && session.founder !== undefined) {
      sessionFounder = session.founder;
      break;
    }
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- seeds founderInboxOwner once when unset from the authenticated session
  useEffect(() => {
    if (founderInboxOwner !== undefined || sessionFounder === undefined) return;
    void updateClientSettings({ founderInboxOwner: sessionFounder });
  }, [founderInboxOwner, sessionFounder]);
  return null;
}
