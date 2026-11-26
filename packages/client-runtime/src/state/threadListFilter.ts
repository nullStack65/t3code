import {
  effectiveInboxFilter,
  type Founder,
  InboxChoice,
  isHiddenFromFounder,
  matchesPrimaryInbox,
  primaryInbox,
  type EnvironmentId,
  type OrchestrationV2OlderSettledGroup,
  type ThreadInbox,
} from "@t3tools/contracts";
import type { ClientSettings, ThreadAttribution } from "@t3tools/contracts/settings";

import { attributionOfSender, type FounderByEnvironmentId } from "./threadAttribution.ts";

/** What the thread list shows: chosen inboxes, minus hidden environments and senders. */
export interface ThreadListFilter {
  readonly inboxes: ReadonlyArray<InboxChoice>;
  readonly hiddenEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly hiddenAttributions: ReadonlyArray<ThreadAttribution>;
  /**
   * The founder reading this list. Jeff's list never holds Kameron's private threads or bots,
   * whatever the inbox checkboxes say (`isHiddenFromFounder`). Absent: no founder chosen.
   */
  readonly viewingFounder?: Founder | undefined;
}

interface FilterableThread {
  readonly environmentId: EnvironmentId;
  /** Set on a standing bot. Those bypass the inbox and From checkboxes. */
  readonly standing?: unknown;
  readonly archivedAt?: unknown;
  readonly source: {
    readonly inbox?: ThreadInbox | null | undefined;
    readonly createdBy?: string | undefined;
  };
}

export const threadListFilterOf = (
  settings: Pick<
    ClientSettings,
    | "founderInboxFilter"
    | "founderInboxOwner"
    | "sidebarHiddenEnvironmentIds"
    | "sidebarHiddenThreadAttributions"
  >,
): ThreadListFilter => ({
  inboxes: effectiveInboxFilter(settings),
  hiddenEnvironmentIds: settings.sidebarHiddenEnvironmentIds ?? [],
  hiddenAttributions: settings.sidebarHiddenThreadAttributions ?? [],
  viewingFounder: settings.founderInboxOwner,
});

/** Inbox membership from what a thread or an older settled group carries. */
export const matchesListedInboxes = (
  inbox: InboxChoice | null,
  agentCreated: boolean,
  inboxes: ReadonlyArray<InboxChoice>,
) =>
  matchesPrimaryInbox(inbox, inboxes) ||
  // Agent-created threads from before inbox routing carry no Agents routing.
  (inboxes.includes("agents") && agentCreated && inbox === null);

/** A non-archived standing bot stays in the list unless it is private to the other founder. */
export const standingBotBypassesListFilters = (thread: {
  readonly standing?: unknown;
  readonly archivedAt?: unknown;
}) => thread.standing != null && thread.archivedAt == null;

/** Without an attribution (notifications), the From section does not apply. */
export const matchesThreadListFilter = (
  thread: FilterableThread,
  filter: ThreadListFilter,
  attribution?: ThreadAttribution,
) => {
  if (filter.hiddenEnvironmentIds.includes(thread.environmentId)) return false;
  // Private to the other founder: hidden even for a standing bot, which otherwise bypasses.
  if (isHiddenFromFounder(thread.source.inbox, filter.viewingFounder)) return false;
  // Inbox and From checkboxes hide ordinary threads. A standing bot is hidden only by
  // archiving it or by hiding its environment. Background attention must not drop it.
  if (standingBotBypassesListFilters(thread)) return true;
  return (
    (attribution === undefined || !filter.hiddenAttributions.includes(attribution)) &&
    matchesListedInboxes(
      primaryInbox(thread.source.inbox),
      thread.source.createdBy === "agent",
      filter.inboxes,
    )
  );
};

/** `matchesThreadListFilter` for older settled threads a server counted but did not send. */
export const matchesOlderSettledGroup = (
  environmentId: EnvironmentId,
  group: OrchestrationV2OlderSettledGroup,
  filter: ThreadListFilter,
  owners: FounderByEnvironmentId,
) =>
  !filter.hiddenEnvironmentIds.includes(environmentId) &&
  // A group counts only its primary inbox, so Kameron-filed groups are the ones Jeff can tell apart.
  !(filter.viewingFounder === "jeff" && group.inbox === "kameron") &&
  !filter.hiddenAttributions.includes(attributionOfSender(group, owners[environmentId])) &&
  matchesListedInboxes(group.inbox, group.agentCreated, filter.inboxes);

/** How much of an environment the filter shows, for counts that carry no breakdown. */
export const threadListFilterCoverage = (
  environmentId: EnvironmentId,
  filter: ThreadListFilter,
): "all" | "none" | "some" =>
  filter.hiddenEnvironmentIds.includes(environmentId)
    ? "none"
    : filter.hiddenAttributions.length > 0 ||
        !InboxChoice.literals.every((choice) => filter.inboxes.includes(choice))
      ? "some"
      : "all";
