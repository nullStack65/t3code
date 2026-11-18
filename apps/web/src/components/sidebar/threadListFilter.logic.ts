import {
  effectiveInboxFilter,
  Founder,
  InboxChoice,
  matchesInboxFilter,
  primaryInbox,
  type EnvironmentId,
  type ThreadInbox,
} from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";

export interface ThreadListFilter {
  readonly inboxes: ReadonlyArray<InboxChoice>;
  readonly hiddenEnvironmentIds: ReadonlyArray<EnvironmentId>;
}

interface FilterableThread {
  readonly environmentId: EnvironmentId;
  readonly source: {
    readonly inbox?: ThreadInbox | null | undefined;
    readonly createdBy?: string | undefined;
  };
}

export const threadListFilterOf = (
  settings: Pick<
    ClientSettings,
    "founderInboxFilter" | "founderInboxOwner" | "sidebarHiddenEnvironmentIds"
  >,
): ThreadListFilter => ({
  inboxes: effectiveInboxFilter(settings),
  hiddenEnvironmentIds: settings.sidebarHiddenEnvironmentIds ?? [],
});

const matchesInboxes = (thread: FilterableThread, inboxes: ReadonlyArray<InboxChoice>) =>
  matchesInboxFilter(thread.source.inbox, inboxes) ||
  // Agent-created threads from before inbox routing carry no Agents routing.
  (inboxes.includes("agents") &&
    thread.source.createdBy === "agent" &&
    primaryInbox(thread.source.inbox) === null);

export const matchesThreadListFilter = (thread: FilterableThread, filter: ThreadListFilter) =>
  !filter.hiddenEnvironmentIds.includes(thread.environmentId) &&
  matchesInboxes(thread, filter.inboxes);

/** The chosen founder's inbox first, then Agents, so the common pair sits together. */
export const inboxMenuOrder = (owner: Founder | undefined): ReadonlyArray<InboxChoice> => {
  const first = owner ?? Founder.literals[0];
  return [first, "agents", ...Founder.literals.filter((founder) => founder !== first), "shared"];
};

/**
 * The hidden environments after showing or hiding one. Hidden ids of environments this
 * client has not loaded yet (startup, an offline machine) stay hidden.
 */
export function toggleHiddenEnvironment(
  hidden: ReadonlyArray<EnvironmentId>,
  environmentId: EnvironmentId,
  knownEnvironmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<EnvironmentId> {
  const shown = toggleFilterOption(
    knownEnvironmentIds.filter((id) => !hidden.includes(id)),
    environmentId,
    knownEnvironmentIds,
  );
  return [
    ...hidden.filter((id) => !knownEnvironmentIds.includes(id)),
    ...knownEnvironmentIds.filter((id) => !shown.includes(id)),
  ];
}

const sameMembers = <A>(left: ReadonlyArray<A>, right: ReadonlyArray<A>) =>
  left.length === right.length && left.every((value) => right.includes(value));

/** Filter sections that differ from this device's default, ignoring removed environments. */
export function changedThreadListFilters(
  filter: ThreadListFilter,
  owner: Founder | undefined,
  environmentIds: ReadonlyArray<EnvironmentId>,
): { readonly inboxes: boolean; readonly environments: boolean } {
  return {
    inboxes: !sameMembers(filter.inboxes, effectiveInboxFilter({ founderInboxOwner: owner })),
    environments: filter.hiddenEnvironmentIds.some((id) => environmentIds.includes(id)),
  };
}

/**
 * Faceted counts: each inbox counts threads in the shown environments, and each environment
 * counts threads in the chosen inboxes, so a count is what checking that option would add.
 */
export function threadListFilterCounts(
  threads: ReadonlyArray<FilterableThread>,
  filter: ThreadListFilter,
) {
  const inboxes = new Map<InboxChoice, number>();
  const environments = new Map<EnvironmentId, number>();
  for (const thread of threads) {
    if (!filter.hiddenEnvironmentIds.includes(thread.environmentId)) {
      for (const choice of InboxChoice.literals) {
        if (matchesInboxes(thread, [choice])) inboxes.set(choice, (inboxes.get(choice) ?? 0) + 1);
      }
    }
    if (matchesInboxes(thread, filter.inboxes)) {
      environments.set(thread.environmentId, (environments.get(thread.environmentId) ?? 0) + 1);
    }
  }
  return { inboxes, environments };
}

/** Toggles one option, keeping at least one checked so the list never empties by accident. */
export function toggleFilterOption<A>(
  selected: ReadonlyArray<A>,
  option: A,
  order: ReadonlyArray<A>,
): ReadonlyArray<A> {
  const next = selected.includes(option)
    ? selected.filter((value) => value !== option)
    : [...selected, option];
  if (next.length === 0) return selected;
  return order.filter((value) => next.includes(value));
}
