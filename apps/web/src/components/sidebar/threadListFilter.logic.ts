import {
  matchesListedInboxes,
  type ThreadListFilter,
} from "@t3tools/client-runtime/state/thread-list-filter";
import {
  effectiveInboxFilter,
  founderInboxLane,
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
  readonly settledOverride?: "settled" | "active" | null;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly pendingSubagentRequest?: "approval" | "user_input" | null;
  readonly runtime?: { readonly status: string } | null;
  readonly latestRun?: { readonly status: string } | null;
  readonly source: {
    readonly inbox?: ThreadInbox | null | undefined;
    readonly createdBy?: string | undefined;
  };
}

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

const FINISHED_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

export type ThreadListFilterBucket = "working" | "done" | "needsMe";

export interface ThreadListFilterBucketCounts {
  readonly working: number;
  readonly done: number;
  readonly needsMe: number;
}

export const EMPTY_THREAD_LIST_FILTER_BUCKETS: ThreadListFilterBucketCounts = {
  working: 0,
  done: 0,
  needsMe: 0,
};

const activityStatus = (thread: FilterableThread) =>
  thread.runtime?.status ?? thread.latestRun?.status ?? null;

const waitsOnHuman = (thread: FilterableThread, viewingFounder: Founder | undefined) => {
  if (
    thread.hasPendingApprovals === true ||
    thread.hasPendingUserInput === true ||
    thread.pendingSubagentRequest != null
  ) {
    return true;
  }
  const inbox = thread.source.inbox;
  if (inbox?.pendingHumanRequest === true) {
    if (viewingFounder === undefined || inbox.owner === viewingFounder || inbox.owner === null) {
      return true;
    }
  }
  const ask = inbox?.decisionRequest;
  return ask !== undefined && (viewingFounder === undefined || ask.founder === viewingFounder);
};

const attentionForFounder = (thread: FilterableThread, viewingFounder: Founder | undefined) => {
  if (viewingFounder === undefined) return false;
  const inbox = thread.source.inbox;
  return inbox?.attentionKind === "action" && founderInboxLane(inbox, viewingFounder) === "action";
};

export function threadListFilterBucket(
  thread: FilterableThread,
  viewingFounder?: Founder,
): ThreadListFilterBucket | null {
  if (thread.settledOverride === "settled") return null;
  const status = activityStatus(thread);
  if (waitsOnHuman(thread, viewingFounder)) return "needsMe";
  if (thread.runtime?.status === "idle") return "working";
  if (status !== null && ACTIVE_RUN_STATUSES.has(status)) return "working";
  if (attentionForFounder(thread, viewingFounder)) return "needsMe";
  if (
    (status !== null && FINISHED_RUN_STATUSES.has(status)) ||
    (thread.latestRun != null && FINISHED_RUN_STATUSES.has(thread.latestRun.status))
  ) {
    return "done";
  }
  return null;
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

const addBucket = <K>(
  counts: Map<K, ThreadListFilterBucketCounts>,
  key: K,
  bucket: ThreadListFilterBucket | null,
) => {
  const current = counts.get(key) ?? EMPTY_THREAD_LIST_FILTER_BUCKETS;
  counts.set(key, bucket === null ? current : { ...current, [bucket]: current[bucket] + 1 });
};

/**
 * Faceted counts: each section counts threads that pass the other two sections, so a count
 * is what checking that option would add.
 */
export function threadListFilterCounts<T extends FilterableThread>(
  threads: ReadonlyArray<T>,
  filter: ThreadListFilter,
  attributionOf: (thread: T) => ThreadAttribution,
  viewingFounder?: Founder,
) {
  const inboxes = new Map<InboxChoice, ThreadListFilterBucketCounts>();
  const environments = new Map<EnvironmentId, ThreadListFilterBucketCounts>();
  const from = new Map<ThreadAttribution, ThreadListFilterBucketCounts>();
  for (const thread of threads) {
    const bucket = threadListFilterBucket(thread, viewingFounder);
    const attribution = attributionOf(thread);
    const environmentShown = !filter.hiddenEnvironmentIds.includes(thread.environmentId);
    const fromShown = !filter.hiddenAttributions.includes(attribution);
    const inboxShown = matchesInboxes(thread, filter.inboxes);
    if (environmentShown && fromShown) {
      for (const choice of InboxChoice.literals) {
        if (matchesInboxes(thread, [choice])) addBucket(inboxes, choice, bucket);
      }
    }
    if (inboxShown && fromShown) addBucket(environments, thread.environmentId, bucket);
    if (inboxShown && environmentShown) addBucket(from, attribution, bucket);
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
