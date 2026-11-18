import type { EnvironmentId, Founder } from "@t3tools/contracts";

import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import { useEnvironmentIdentities } from "../../state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const OWNER_LABELS = { kameron: "Kameron", jeff: "Jeff" } as const;

/** Which founder new threads from this device are filed under; the sidebar filter only views. */
export function NewThreadInboxRow() {
  const owner = useClientSettings((settings) => settings.founderInboxOwner);
  return (
    <SettingsRow
      {...searchableSetting("new-thread-inbox")}
      description="Threads you start on this device go to this inbox. Until you choose, they stay unfiled."
      control={
        <div className="w-full sm:w-40">
          <Select
            value={owner ?? null}
            onValueChange={(value) => {
              if (value === "kameron" || value === "jeff")
                void updateClientSettings({ founderInboxOwner: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label="New threads belong to">
              <SelectValue>{owner ? OWNER_LABELS[owner] : "Not set"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="kameron">Kameron</SelectItem>
              <SelectItem value="jeff">Jeff</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}

const UNSET = "unset";

/** Which founder each machine belongs to, for threads older than inbox attribution. */
export function MachineOwnersRow() {
  const environments = useEnvironmentIdentities();
  const owners = useClientSettings((settings) => settings.founderByEnvironmentId) ?? {};
  const setOwner = (environmentId: EnvironmentId, founder: Founder | null) => {
    // Read at change time, so a second quick edit or another tab's edit is not overwritten.
    const next = { ...getClientSettings().founderByEnvironmentId };
    if (founder === null) delete next[environmentId];
    else next[environmentId] = founder;
    void updateClientSettings({ founderByEnvironmentId: next });
  };
  return (
    <SettingsRow
      {...searchableSetting("machine-owners")}
      description="Older threads without sender details are credited to the machine's owner. Unset machines show as Unknown."
    >
      <div className="flex flex-col gap-2 pt-2">
        {environments.map(({ environmentId, label }) => {
          const owner = owners[environmentId];
          return (
            <div key={environmentId} className="flex items-center justify-between gap-4">
              <span className="min-w-0 truncate text-sm">{label}</span>
              <div className="w-40 shrink-0">
                <Select
                  value={owner ?? UNSET}
                  onValueChange={(value) =>
                    setOwner(environmentId, value === "kameron" || value === "jeff" ? value : null)
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full min-w-0"
                    aria-label={`Owner of ${label}`}
                  >
                    <SelectValue>{owner ? OWNER_LABELS[owner] : "Not set"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem value={UNSET}>Not set</SelectItem>
                    <SelectItem value="kameron">Kameron</SelectItem>
                    <SelectItem value="jeff">Jeff</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            </div>
          );
        })}
      </div>
    </SettingsRow>
  );
}
