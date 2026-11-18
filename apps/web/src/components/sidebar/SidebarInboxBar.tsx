import { effectiveInboxView, type InboxView } from "@t3tools/contracts";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";

/** A local view of the shared pool; All and search always include every thread. */
export function SidebarInboxBar() {
  const view = useClientSettings(effectiveInboxView);
  const owner = useClientSettings((settings) => settings.founderInboxOwner);
  return (
    <div className="flex flex-wrap items-center gap-2 px-2 pb-2 text-xs text-muted-foreground">
      <label>
        Inbox{" "}
        <select
          aria-label="Inbox"
          value={view}
          onChange={(event) => {
            const founderInboxView = event.target.value as InboxView;
            void updateClientSettings({
              founderInboxView,
              ...(founderInboxView === "kameron" || founderInboxView === "jeff"
                ? { founderInboxOwner: founderInboxView }
                : {}),
            });
          }}
        >
          <option value="kameron">Kameron</option>
          <option value="jeff">Jeff</option>
          <option value="shared">Shared</option>
          <option value="agents">Agents</option>
          <option value="all">All threads</option>
        </select>
      </label>
      <label>
        New threads{" "}
        <select
          aria-label="Owner for new threads"
          value={owner ?? ""}
          onChange={(event) =>
            void updateClientSettings({
              founderInboxOwner: event.target.value === "jeff" ? "jeff" : "kameron",
            })
          }
        >
          {owner === undefined ? (
            <option value="" disabled>
              Not set
            </option>
          ) : null}
          <option value="kameron">Kameron</option>
          <option value="jeff">Jeff</option>
        </select>
      </label>
    </div>
  );
}
