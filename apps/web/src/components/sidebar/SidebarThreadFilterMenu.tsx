import {
  effectiveInboxFilter,
  type EnvironmentId,
  type Founder,
  type InboxChoice,
} from "@t3tools/contracts";
import {
  THREAD_ATTRIBUTION_LABELS,
  THREAD_ATTRIBUTIONS,
} from "@t3tools/client-runtime/state/thread-attribution";
import type { ThreadAttribution } from "@t3tools/contracts/settings";
import { SlidersHorizontalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { useSidebarEnvironmentIdentities } from "../../state/linkedSidebar";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import {
  changedThreadListFilters,
  inboxMenuOrder,
  threadListFilterCounts,
  threadListFilterOf,
  toggleFilterOption,
  toggleHiddenEnvironment,
  type ThreadListFilter,
} from "./threadListFilter.logic";

const INBOX_LABELS: Record<InboxChoice, string> = {
  kameron: "Kameron",
  jeff: "Jeff",
  agents: "Agents",
  shared: "Shared",
};

type CountedThread = Parameters<typeof threadListFilterCounts>[0][number];
const LAST_OPTION_NOTE = ", the last one shown, so it stays checked";

/** Chooses which inboxes and environments the thread list shows. Search still finds every thread. */
export function SidebarThreadFilterMenu<T extends CountedThread>({
  countedThreads,
  attributionOf,
}: {
  /** Called only while the menu is open. */
  countedThreads: () => ReadonlyArray<T>;
  attributionOf: (thread: T) => ThreadAttribution;
}) {
  const filter = useClientSettings(threadListFilterOf);
  const owner = useClientSettings((settings) => settings.founderInboxOwner);
  const environments = useSidebarEnvironmentIdentities();
  const environmentIds = environments.map((environment) => environment.environmentId);
  const changed = changedThreadListFilters(filter, owner, environmentIds);
  const hiddenCount = environmentIds.filter((id) =>
    filter.hiddenEnvironmentIds.includes(id),
  ).length;
  const summary = [
    changed.inboxes ? filter.inboxes.map((inbox) => INBOX_LABELS[inbox]).join(", ") : null,
    changed.environments
      ? `${hiddenCount} environment${hiddenCount === 1 ? "" : "s"} hidden`
      : null,
    changed.from
      ? `from ${THREAD_ATTRIBUTIONS.filter((from) => !filter.hiddenAttributions.includes(from))
          .map((from) => THREAD_ATTRIBUTION_LABELS[from])
          .join(", ")}`
      : null,
  ].filter((part) => part !== null);
  const label =
    summary.length === 0
      ? "Filter threads by inbox, sender and environment"
      : `Filter threads by inbox, sender and environment (${summary.join("; ")})`;
  return (
    <Menu>
      <MenuTrigger render={<SidebarHeaderIconButton label={label} />}>
        <SlidersHorizontalIcon className={cn("size-4", summary.length > 0 && "text-primary")} />
      </MenuTrigger>
      <MenuPopup align="end" className="w-[min(16rem,var(--available-width))]">
        <SidebarThreadFilterOptions
          countedThreads={countedThreads}
          attributionOf={attributionOf}
          filter={filter}
          owner={owner}
          environments={environments}
          isChanged={summary.length > 0}
        />
      </MenuPopup>
    </Menu>
  );
}

// Mounted only while the menu is open, so counting never runs on streaming ticks.
function SidebarThreadFilterOptions<T extends CountedThread>({
  countedThreads,
  attributionOf,
  filter,
  owner,
  environments,
  isChanged,
}: {
  countedThreads: () => ReadonlyArray<T>;
  attributionOf: (thread: T) => ThreadAttribution;
  filter: ThreadListFilter;
  owner: Founder | undefined;
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>;
  isChanged: boolean;
}) {
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const counts = threadListFilterCounts(countedThreads(), filter, attributionOf);
  const shownAttributions = THREAD_ATTRIBUTIONS.filter(
    (from) => !filter.hiddenAttributions.includes(from),
  );
  const inboxOrder = inboxMenuOrder(owner);
  const environmentIds = environments.map((environment) => environment.environmentId);
  const shownEnvironmentIds = environmentIds.filter(
    (id) => !filter.hiddenEnvironmentIds.includes(id),
  );
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>Inbox</MenuGroupLabel>
        {inboxOrder.map((inbox) => {
          const checked = filter.inboxes.includes(inbox);
          const isLast = checked && filter.inboxes.length === 1;
          const count = counts.inboxes.get(inbox) ?? 0;
          return (
            <MenuCheckboxItem
              key={inbox}
              checked={checked}
              disabled={isLast}
              aria-label={`${INBOX_LABELS[inbox]}, ${count} active${isLast ? LAST_OPTION_NOTE : ""}`}
              onCheckedChange={() =>
                void updateClientSettings({
                  founderInboxFilter: toggleFilterOption(filter.inboxes, inbox, inboxOrder),
                })
              }
            >
              <FilterOptionRow label={INBOX_LABELS[inbox]} count={count} />
            </MenuCheckboxItem>
          );
        })}
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup>
        <MenuGroupLabel>From</MenuGroupLabel>
        {THREAD_ATTRIBUTIONS.map((from) => {
          const checked = shownAttributions.includes(from);
          const isLast = checked && shownAttributions.length === 1;
          const count = counts.from.get(from) ?? 0;
          return (
            <MenuCheckboxItem
              key={from}
              checked={checked}
              disabled={isLast}
              aria-label={`From ${THREAD_ATTRIBUTION_LABELS[from]}, ${count} active${isLast ? LAST_OPTION_NOTE : ""}`}
              onCheckedChange={() => {
                const shown = toggleFilterOption(shownAttributions, from, THREAD_ATTRIBUTIONS);
                void updateClientSettings({
                  sidebarHiddenThreadAttributions: THREAD_ATTRIBUTIONS.filter(
                    (candidate) => !shown.includes(candidate),
                  ),
                });
              }}
            >
              <FilterOptionRow label={THREAD_ATTRIBUTION_LABELS[from]} count={count} />
            </MenuCheckboxItem>
          );
        })}
      </MenuGroup>
      {environments.length > 1 ? (
        <>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Environments</MenuGroupLabel>
            {environments.map((environment) => {
              const checked = shownEnvironmentIds.includes(environment.environmentId);
              const isLast = checked && shownEnvironmentIds.length === 1;
              const connected = connectedEnvironmentIds.includes(environment.environmentId);
              const count = counts.environments.get(environment.environmentId) ?? 0;
              return (
                <MenuCheckboxItem
                  key={environment.environmentId}
                  checked={checked}
                  disabled={isLast}
                  aria-label={`${environment.label}, ${connected ? "connected" : "not connected"}, ${count} active${isLast ? LAST_OPTION_NOTE : ""}`}
                  onCheckedChange={() =>
                    void updateClientSettings({
                      sidebarHiddenEnvironmentIds: toggleHiddenEnvironment(
                        filter.hiddenEnvironmentIds,
                        environment.environmentId,
                        environmentIds,
                      ),
                    })
                  }
                >
                  <FilterOptionRow
                    label={environment.label}
                    count={count}
                    indicator={
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          connected ? "bg-success" : "bg-muted-foreground/40",
                        )}
                      />
                    }
                  />
                </MenuCheckboxItem>
              );
            })}
          </MenuGroup>
        </>
      ) : null}
      {isChanged ? (
        <>
          <MenuSeparator />
          <MenuItem
            onClick={() =>
              void updateClientSettings({
                founderInboxFilter: effectiveInboxFilter({ founderInboxOwner: owner }),
                sidebarHiddenEnvironmentIds: [],
                sidebarHiddenThreadAttributions: [],
              })
            }
          >
            Reset to default
          </MenuItem>
        </>
      ) : null}
    </>
  );
}

function FilterOptionRow({
  label,
  count,
  indicator,
}: {
  label: string;
  count: number;
  indicator?: ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {indicator}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{count}</span>
    </span>
  );
}
