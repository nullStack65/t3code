import type { EnvironmentId } from "@t3tools/contracts";

import {
  ensureClientSettingsHydrated,
  getClientSettings,
  isClientSettingsHydrated,
  persistClientSettingsPatch,
} from "../hooks/useSettings";

// Once hydrated, a patch shows in the settings snapshot at once, before it is stored, so the
// automatic add never sees a removed machine as missing and not dismissed. Resolves to whether
// it changed anything.
const setDismissed = async (environmentId: EnvironmentId, dismissed: boolean) => {
  if (!isClientSettingsHydrated()) {
    await ensureClientSettingsHydrated().catch(() => undefined);
  }
  const current = getClientSettings().dismissedLinkedEnvironmentIds;
  if (current.includes(environmentId) === dismissed) return false;
  const others = current.filter((id) => id !== environmentId);
  await persistClientSettingsPatch({
    dismissedLinkedEnvironmentIds: dismissed ? [...others, environmentId] : others,
  }).catch(() => undefined);
  return true;
};

/**
 * Keeps a linked machine the user removes from this app out of it: it is no longer added on its
 * own. Call it before removing, whether or not any host's links are loaded. Resolves to an undo
 * for a removal that failed, which clears only a dismissal this call wrote.
 */
export async function dismissLinkedEnvironment(
  environmentId: EnvironmentId,
): Promise<() => Promise<void>> {
  const wrote = await setDismissed(environmentId, true);
  return async () => {
    if (wrote) await setDismissed(environmentId, false);
  };
}

/** Lets a linked machine be added on its own again: the user added it back, by any path. */
export function undismissLinkedEnvironment(environmentId: EnvironmentId): Promise<void> {
  return setDismissed(environmentId, false).then(() => undefined);
}
