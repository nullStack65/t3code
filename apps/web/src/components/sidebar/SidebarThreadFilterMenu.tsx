import {
  effectiveInboxFilter,
  type EnvironmentId,
  type Founder,
  type InboxChoice,
} from "@t3tools/contracts";
import { SlidersHorizontalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../../state/environments";
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
  type ThreadListFilter,
} from "./threadListFilter.logic";

const INBOX_LABELS: Record<InboxChoice, string> = {
  kameron: "Kameron",
  jeff: "Jeff",
  agents: "Agents",
  shared: "Shared",
};

type CountedThreads = Parameters<typeof threadListFilterCounts>[0];

/** Chooses which inboxes and environments the thread list shows. Search still finds every thread. */
export function SidebarThreadFilterMenu({
  countedThreads,
}: {
  /** Called only while the menu is open. */
  countedThreads: () => CountedThreads;
}) {
  const filter = useClientSettings(threadListFilterOf);
  const owner = useClientSettings((settings) => settings.founderInboxOwner);
  const environments = useEnvironmentIdentities();
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
  ].filter((part) => part !== null);
  const label =
    summary.length === 0
      ? "Filter threads by inbox and environment"
      : `Filter threads by inbox and environment (${summary.join("; ")})`;
  return (
    <Menu>
      <MenuTrigger render={<SidebarHeaderIconButton label={label} />}>
        <SlidersHorizontalIcon className="size-4" />
        {summary.length > 0 ? (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-primary"
          />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" className="w-[min(16rem,var(--available-width))]">
        <SidebarThreadFilterOptions
          countedThreads={countedThreads}
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
function SidebarThreadFilterOptions({
  countedThreads,
  filter,
  owner,
  environments,
  isChanged,
}: {
  countedThreads: () => CountedThreads;
  filter: ThreadListFilter;
  owner: Founder | undefined;
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>;
  isChanged: boolean;
}) {
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const counts = threadListFilterCounts(countedThreads(), filter);
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
          const count = counts.inboxes.get(inbox) ?? 0;
          return (
            <MenuCheckboxItem
              key={inbox}
              checked={checked}
              disabled={checked && filter.inboxes.length === 1}
              aria-label={`${INBOX_LABELS[inbox]}, ${count} active`}
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
      {environments.length > 1 ? (
        <>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Environments</MenuGroupLabel>
            {environments.map((environment) => {
              const checked = shownEnvironmentIds.includes(environment.environmentId);
              const connected = connectedEnvironmentIds.includes(environment.environmentId);
              const count = counts.environments.get(environment.environmentId) ?? 0;
              return (
                <MenuCheckboxItem
                  key={environment.environmentId}
                  checked={checked}
                  disabled={checked && shownEnvironmentIds.length === 1}
                  aria-label={`${environment.label}, ${connected ? "connected" : "not connected"}, ${count} active`}
                  onCheckedChange={() => {
                    const shown = toggleFilterOption(
                      shownEnvironmentIds,
                      environment.environmentId,
                      environmentIds,
                    );
                    void updateClientSettings({
                      sidebarHiddenEnvironmentIds: environmentIds.filter(
                        (id) => !shown.includes(id),
                      ),
                    });
                  }}
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
