import {
  matchesListedInboxes,
  type ThreadListFilter,
} from "@t3tools/client-runtime/state/thread-list-filter";
import {
  effectiveInboxFilter,
  Founder,
  InboxChoice,
  primaryInbox,
  type EnvironmentId,
  type ThreadInbox,
} from "@t3tools/contracts";
import type { ThreadAttribution } from "@t3tools/contracts/settings";

export {
  matchesThreadListFilter,
  threadListFilterOf,
  type ThreadListFilter,
} from "@t3tools/client-runtime/state/thread-list-filter";

interface FilterableThread {
  readonly environmentId: EnvironmentId;
  readonly source: {
    readonly inbox?: ThreadInbox | null | undefined;
    readonly createdBy?: string | undefined;
  };
}

const matchesInboxes = (thread: FilterableThread, inboxes: ReadonlyArray<InboxChoice>) =>
  matchesListedInboxes(
    primaryInbox(thread.source.inbox),
    thread.source.createdBy === "agent",
    inboxes,
  );

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
): { readonly inboxes: boolean; readonly environments: boolean; readonly from: boolean } {
  return {
    inboxes: !sameMembers(filter.inboxes, effectiveInboxFilter({ founderInboxOwner: owner })),
    environments: filter.hiddenEnvironmentIds.some((id) => environmentIds.includes(id)),
    from: filter.hiddenAttributions.length > 0,
  };
}

const increment = <K>(counts: Map<K, number>, key: K) =>
  counts.set(key, (counts.get(key) ?? 0) + 1);

/**
 * Faceted counts: each section counts threads that pass the other two sections, so a count
 * is what checking that option would add.
 */
export function threadListFilterCounts<T extends FilterableThread>(
  threads: ReadonlyArray<T>,
  filter: ThreadListFilter,
  attributionOf: (thread: T) => ThreadAttribution,
) {
  const inboxes = new Map<InboxChoice, number>();
  const environments = new Map<EnvironmentId, number>();
  const from = new Map<ThreadAttribution, number>();
  for (const thread of threads) {
    const attribution = attributionOf(thread);
    const environmentShown = !filter.hiddenEnvironmentIds.includes(thread.environmentId);
    const fromShown = !filter.hiddenAttributions.includes(attribution);
    const inboxShown = matchesInboxes(thread, filter.inboxes);
    if (environmentShown && fromShown) {
      for (const choice of InboxChoice.literals) {
        if (matchesInboxes(thread, [choice])) increment(inboxes, choice);
      }
    }
    if (inboxShown && fromShown) increment(environments, thread.environmentId);
    if (inboxShown && environmentShown) increment(from, attribution);
  }
  return { inboxes, environments, from };
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
