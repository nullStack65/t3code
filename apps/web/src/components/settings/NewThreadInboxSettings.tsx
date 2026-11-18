import { resolveMachineOwners } from "@t3tools/client-runtime/state/thread-attribution";
import { AuthSettingsWriteScope, type EnvironmentId, type Founder } from "@t3tools/contracts";

import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
  useUpdateEnvironmentSettings,
} from "../../hooks/useSettings";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
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

/**
 * Which founder each machine belongs to, for threads older than inbox attribution. The machine
 * stores it, so every app agrees; servers too old to store it use this device's own map.
 */
export function MachineOwnersRow() {
  const environments = useEnvironmentIdentities();
  const serverConfigs = useServerConfigs();
  const legacyOwners = useClientSettings((settings) => settings.founderByEnvironmentId);
  const owners = resolveMachineOwners(serverConfigs, legacyOwners);
  return (
    <SettingsRow
      {...searchableSetting("machine-owners")}
      description="Older threads without sender details are credited to the machine's owner, in every app connected to it. Unset machines show as Unknown."
    >
      <div className="flex flex-col gap-2 pt-2">
        {environments.map(({ environmentId, label }) => (
          <MachineOwnerRow
            key={environmentId}
            environmentId={environmentId}
            label={label}
            owner={owners[environmentId]}
            reportsOwner={serverConfigs.get(environmentId)?.machineOwner === true}
          />
        ))}
      </div>
    </SettingsRow>
  );
}

function MachineOwnerRow(props: {
  environmentId: EnvironmentId;
  label: string;
  owner: Founder | undefined;
  reportsOwner: boolean;
}) {
  const { environmentId, label, owner, reportsOwner } = props;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateEnvironmentSettings = useUpdateEnvironmentSettings(environmentId);
  const setOwner = (founder: Founder | null) => {
    if (reportsOwner) updateEnvironmentSettings({ ownerFounder: founder });
    // Kept for servers too old to store an owner. Read at change time, so a second quick edit
    // or another tab's edit is not overwritten.
    const next = { ...getClientSettings().founderByEnvironmentId };
    if (founder === null) delete next[environmentId];
    else next[environmentId] = founder;
    void updateClientSettings({ founderByEnvironmentId: next });
  };
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="min-w-0 truncate text-sm">{label}</span>
      <div className="w-40 shrink-0">
        <Select
          value={owner ?? UNSET}
          disabled={reportsOwner && !canWrite}
          onValueChange={(value) =>
            setOwner(value === "kameron" || value === "jeff" ? value : null)
          }
        >
          <SelectTrigger
            size="sm"
            className="w-full min-w-0"
            aria-label={
              reportsOwner && !canWrite
                ? `Owner of ${label}; this connection cannot change it`
                : `Owner of ${label}`
            }
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
}
