import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
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
