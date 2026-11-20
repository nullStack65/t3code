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
  EMPTY_THREAD_LIST_FILTER_BUCKETS,
  inboxMenuOrder,
  threadListFilterCounts,
  threadListFilterOf,
  toggleFilterOption,
  toggleHiddenEnvironment,
  type OlderSettledCounts,
  type ThreadListFilter,
  type ThreadListFilterBucketCounts,
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
  olderSettled,
  attributionOf,
}: {
  /** Called only while the menu is open. */
  countedThreads: () => ReadonlyArray<T>;
  olderSettled: () => OlderSettledCounts<T>;
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
      <MenuPopup align="end" className="w-[min(19rem,var(--available-width))]">
        <SidebarThreadFilterOptions
          countedThreads={countedThreads}
          olderSettled={olderSettled}
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
  olderSettled,
  attributionOf,
  filter,
  owner,
  environments,
  isChanged,
}: {
  countedThreads: () => ReadonlyArray<T>;
  olderSettled: () => OlderSettledCounts<T>;
  attributionOf: (thread: T) => ThreadAttribution;
  filter: ThreadListFilter;
  owner: Founder | undefined;
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>;
  isChanged: boolean;
}) {
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const inboxOrder = inboxMenuOrder(owner);
  const counts = threadListFilterCounts(
    countedThreads(),
    filter,
    attributionOf,
    owner,
    olderSettled(),
  );
  const allInboxesShown = inboxOrder.every((inbox) => filter.inboxes.includes(inbox));
  const shownAttributions = THREAD_ATTRIBUTIONS.filter(
    (from) => !filter.hiddenAttributions.includes(from),
  );
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
          const count = counts.inboxes.get(inbox) ?? EMPTY_THREAD_LIST_FILTER_BUCKETS;
          return (
            <MenuCheckboxItem
              key={inbox}
              checked={checked}
              disabled={isLast}
              aria-label={`${INBOX_LABELS[inbox]}, ${stateCountPhrase(count)}${isLast ? LAST_OPTION_NOTE : ""}`}
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
          const count = counts.from.get(from) ?? EMPTY_THREAD_LIST_FILTER_BUCKETS;
          return (
            <MenuCheckboxItem
              key={from}
              checked={checked}
              disabled={isLast}
              aria-label={`From ${THREAD_ATTRIBUTION_LABELS[from]}, ${stateCountPhrase(count)}${isLast ? LAST_OPTION_NOTE : ""}`}
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
              const count =
                counts.environments.get(environment.environmentId) ??
                EMPTY_THREAD_LIST_FILTER_BUCKETS;
              return (
                <MenuCheckboxItem
                  key={environment.environmentId}
                  checked={checked}
                  disabled={isLast}
                  aria-label={`${environment.label}, ${connected ? "connected" : "not connected"}, ${stateCountPhrase(count)}${isLast ? LAST_OPTION_NOTE : ""}`}
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
      <MenuSeparator />
      <p className="px-2 py-1.5 text-muted-foreground text-xs">
        {!allInboxesShown && counts.unclassified > 0
          ? `${counts.unclassified} thread${counts.unclassified === 1 ? " has" : "s have"} no inbox and ${counts.unclassified === 1 ? "shows" : "show"} only with every inbox checked. `
          : null}
        Delegated and subagent threads are not counted here; open them from their parent thread.
      </p>
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

const STATE_COUNT_COLUMNS = [
  ["working", "working"],
  ["done", "done"],
  ["needsMe", "needs me"],
  ["settled", "settled"],
] as const satisfies ReadonlyArray<readonly [keyof ThreadListFilterBucketCounts, string]>;

function stateCountPhrase(counts: ThreadListFilterBucketCounts) {
  return STATE_COUNT_COLUMNS.map(([key, label]) => `${counts[key]} ${label}`).join(", ");
}

function FilterOptionRow({
  label,
  count,
  indicator,
}: {
  label: string;
  count: ThreadListFilterBucketCounts;
  indicator?: ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {indicator}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="grid shrink-0 grid-cols-4 gap-x-1.5 text-center">
        {STATE_COUNT_COLUMNS.map(([key, name]) => {
          const value = count[key];
          return (
            <span
              key={key}
              className={cn(
                "text-3xs leading-tight tabular-nums",
                value === 0
                  ? "text-muted-foreground/40"
                  : key === "working"
                    ? "text-info-foreground"
                    : key === "done"
                      ? "text-success-foreground"
                      : key === "needsMe"
                        ? "text-warning-foreground"
                        : "text-muted-foreground",
              )}
            >
              <span className="block">{value}</span>
              <span className="block">{name}</span>
            </span>
          );
        })}
      </span>
    </span>
  );
}
