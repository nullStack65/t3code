import {
  matchesListedInboxes,
  standingBotBypassesListFilters,
  matchesThreadListFilter,
  type ThreadListFilter,
} from "@t3tools/client-runtime/state/thread-list-filter";
import {
  attributionOfSender,
  type FounderByEnvironmentId,
} from "@t3tools/client-runtime/state/thread-attribution";
import type { OlderSettled, OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import {
  effectiveInboxFilter,
  isOlderSettledThreadShell,
  founderInboxLane,
  Founder,
  InboxChoice,
  isHiddenFromFounder,
  primaryInbox,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
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
  readonly standing?: unknown;
  readonly archivedAt?: unknown;
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

/**
 * Whether the Inbox menu must keep `Shared` checked: with only the founder's own inbox
 * plus `Shared` selected, unchecking `Shared` would be a founder-only selection.
 */
export function inboxKeepsSharedChecked(
  inbox: InboxChoice,
  filter: ThreadListFilter,
  owner: Founder | undefined,
) {
  return (
    inbox === "shared" &&
    filter.inboxes.includes("shared") &&
    owner !== undefined &&
    filter.inboxes.length === 2 &&
    filter.inboxes.includes(owner)
  );
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

export type ThreadListFilterBucket = "working" | "done" | "needsMe" | "settled";

export interface ThreadListFilterBucketCounts {
  readonly working: number;
  readonly done: number;
  readonly needsMe: number;
  readonly settled: number;
}

export const EMPTY_THREAD_LIST_FILTER_BUCKETS: ThreadListFilterBucketCounts = {
  working: 0,
  done: 0,
  needsMe: 0,
  settled: 0,
};

export interface OlderSettledGroupCount {
  readonly environmentId: EnvironmentId;
  readonly inbox: InboxChoice | null;
  readonly agentCreated: boolean;
  readonly attribution: ThreadAttribution;
  readonly count: number;
}

export function olderSettledFilterCounts(
  scopes: ReadonlyArray<OlderSettledScope>,
  olderOf: (environmentId: EnvironmentId) => OlderSettled | null,
  owners: FounderByEnvironmentId,
) {
  const grouped = scopes.flatMap((scope) => {
    const older = olderOf(scope.environmentId);
    return older?.groups == null ? [] : [{ scope, older, groups: older.groups }];
  });
  const groups: ReadonlyArray<OlderSettledGroupCount> = grouped.flatMap(({ scope, groups }) =>
    (scope.projectIds ?? [...groups.keys()]).flatMap((projectId) =>
      (groups.get(projectId) ?? []).map((group) => ({
        environmentId: scope.environmentId,
        inbox: group.inbox,
        agentCreated: group.agentCreated,
        attribution: attributionOfSender(group, owners[scope.environmentId]),
        count: group.count,
      })),
    ),
  );
  const lowerBound = scopes.some((scope) => {
    const older = olderOf(scope.environmentId);
    if (older === null || older.groups !== null) return false;
    return (scope.projectIds ?? [...older.counts.keys()]).some(
      (projectId) => (older.counts.get(projectId) ?? 0) > 0,
    );
  });
  return {
    groups,
    lowerBound,
    covers: (thread: {
      readonly environmentId: EnvironmentId;
      readonly source: Pick<
        OrchestrationV2ThreadShell,
        "lineage" | "settledOverride" | "settledAt"
      >;
    }) =>
      grouped.some(
        ({ scope, older }) =>
          scope.environmentId === thread.environmentId &&
          isOlderSettledThreadShell(thread.source, older.beforeMs),
      ),
  };
}

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
  if (thread.settledOverride === "settled") return "settled";
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

/**
 * The filter popover must not size itself from the sidebar's collision width.
 * `--available-width` there is only a few characters, which truncated every label.
 */
export const SIDEBAR_FILTER_POPUP_CLASS = "w-[40rem] max-w-[calc(100vw-1rem)]";

/** Labels stay one full line beside the four count columns. */
export const SIDEBAR_FILTER_OPTION_LABEL_CLASS = "min-w-[16rem] shrink-0 whitespace-nowrap";

/** The default pair comes first for a founder. */
export const inboxMenuOrder = (owner: Founder | undefined): ReadonlyArray<InboxChoice> => {
  const first = owner ?? Founder.literals[0];
  return [first, "shared", "agents", ...Founder.literals.filter((founder) => founder !== first)];
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

/**
 * Class for the filter sliders icon.
 *
 * `SidebarMenuButton` sets `[&>svg]:text-[var(--sidebar-icon-color)]` on the
 * button, and that rule beats a plain `text-primary` on the icon, at rest and
 * on hover. The important utility is what makes a non-default filter visible.
 */
export function sidebarFilterIconClass(changed: boolean): string {
  return changed ? "size-4 text-primary!" : "size-4";
}

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
  amount: number,
) => {
  const current = counts.get(key) ?? EMPTY_THREAD_LIST_FILTER_BUCKETS;
  counts.set(key, bucket === null ? current : { ...current, [bucket]: current[bucket] + amount });
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
  olderGroups: ReadonlyArray<OlderSettledGroupCount> = [],
) {
  const inboxes = new Map<InboxChoice, ThreadListFilterBucketCounts>();
  const environments = new Map<EnvironmentId, ThreadListFilterBucketCounts>();
  const from = new Map<ThreadAttribution, ThreadListFilterBucketCounts>();
  let unclassified = 0;
  const tally = (entry: {
    readonly environmentId: EnvironmentId;
    readonly inbox: InboxChoice | null;
    readonly agentCreated: boolean;
    readonly attribution: ThreadAttribution;
    readonly bucket: ThreadListFilterBucket | null;
    readonly amount: number;
    readonly standingVisible?: boolean;
  }) => {
    const environmentShown = !filter.hiddenEnvironmentIds.includes(entry.environmentId);
    // Standing bots stay listed, so their environment still counts when Inbox or From would drop them.
    const fromShown =
      entry.standingVisible || !filter.hiddenAttributions.includes(entry.attribution);
    const inboxShown =
      entry.standingVisible ||
      matchesListedInboxes(entry.inbox, entry.agentCreated, filter.inboxes);
    if (environmentShown && fromShown) {
      for (const choice of InboxChoice.literals) {
        if (matchesListedInboxes(entry.inbox, entry.agentCreated, [choice])) {
          addBucket(inboxes, choice, entry.bucket, entry.amount);
        }
      }
      if (entry.bucket !== null && entry.inbox === null && !entry.agentCreated) {
        unclassified += entry.amount;
      }
    }
    if (inboxShown && fromShown) {
      addBucket(environments, entry.environmentId, entry.bucket, entry.amount);
    }
    if (inboxShown && environmentShown) {
      addBucket(from, entry.attribution, entry.bucket, entry.amount);
    }
  };
  for (const thread of threads) {
    if (isHiddenFromFounder(thread.source.inbox, filter.viewingFounder)) continue;
    tally({
      environmentId: thread.environmentId,
      inbox: primaryInbox(thread.source.inbox),
      agentCreated: thread.source.createdBy === "agent",
      attribution: attributionOf(thread),
      bucket: threadListFilterBucket(thread, viewingFounder),
      amount: 1,
      standingVisible: standingBotBypassesListFilters(thread),
    });
  }
  for (const group of olderGroups) {
    if (filter.viewingFounder === "jeff" && group.inbox === "kameron") continue;
    tally({ ...group, bucket: "settled", amount: group.count });
  }
  return { inboxes, environments, from, unclassified };
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
