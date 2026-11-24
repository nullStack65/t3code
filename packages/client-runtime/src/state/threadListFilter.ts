import {
  effectiveInboxFilter,
  InboxChoice,
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
}

interface FilterableThread {
  readonly environmentId: EnvironmentId;
  /** Set on a standing bot. Those stay listed for both founders. */
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

/** A non-archived standing bot stays in the list for both founders. */
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
