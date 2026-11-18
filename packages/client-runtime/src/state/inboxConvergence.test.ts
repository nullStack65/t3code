import {
  EnvironmentId,
  InboxChoice,
  inboxRoutingFor,
  isOlderSettledThreadShell,
  makeThreadInbox,
  primaryInbox,
  ProjectId,
  resolveThreadSenders,
  ThreadId,
  type Founder,
  type OrchestrationV2OlderSettledCount,
  type OrchestrationV2ThreadShell,
  type ThreadInbox,
} from "@t3tools/contracts";
import type { ThreadAttribution } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  olderSettledCountsOf,
  settledShelfTotal,
  type OlderSettled,
} from "./olderSettledThreads.ts";
import {
  resolveMachineOwners,
  resolveThreadAttributions,
  threadAttributionKey,
  type FounderByEnvironmentId,
  type MachineOwnerConfig,
} from "./threadAttribution.ts";
import {
  matchesOlderSettledGroup,
  matchesThreadListFilter,
  threadListFilterCoverage,
  type ThreadListFilter,
} from "./threadListFilter.ts";

const DAY = 24 * 60 * 60 * 1000;
const CUT_MS = 50 * DAY;
const project = ProjectId.make("project");
const kameron = { kind: "human", id: "kameron" } as const;
const jeff = { kind: "human", id: "jeff" } as const;
const bot = { kind: "agent", id: "lead" } as const;

// Kameron's ASUS and Jeff's Air report their owners; a machine whose owner was cleared reports
// null; a 0.1.9 laptop reports nothing and sends every thread.
const asus = EnvironmentId.make("asus");
const air = EnvironmentId.make("air");
const cleared = EnvironmentId.make("cleared");
const legacyLaptop = EnvironmentId.make("laptop-0-1-9");

interface Row {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly lineage: OrchestrationV2ThreadShell["lineage"];
  readonly source: Pick<
    OrchestrationV2ThreadShell,
    "id" | "projectId" | "lineage" | "settledOverride" | "settledAt" | "createdBy"
  > & { readonly inbox?: ThreadInbox; readonly pinnedAt: DateTime.Utc | null };
}

const row = (
  environmentId: EnvironmentId,
  id: string,
  input: {
    readonly inbox?: ThreadInbox;
    readonly settledDay?: number;
    readonly parent?: string;
    readonly createdBy?: "user" | "agent";
    readonly pinned?: boolean;
  } = {},
): Row => {
  const lineage = {
    parentThreadId: input.parent === undefined ? null : ThreadId.make(input.parent),
    relationshipToParent: null,
    rootThreadId: ThreadId.make(input.parent ?? id),
  } as const;
  return {
    environmentId,
    id: ThreadId.make(id),
    lineage,
    source: {
      id: ThreadId.make(id),
      projectId: project,
      lineage,
      settledOverride: input.settledDay === undefined ? null : "settled",
      settledAt:
        input.settledDay === undefined ? null : DateTime.makeUnsafe(input.settledDay * DAY),
      createdBy: input.createdBy ?? "user",
      pinnedAt: input.pinned === true ? DateTime.makeUnsafe(1) : null,
      ...(input.inbox === undefined ? {} : { inbox: input.inbox }),
    },
  };
};

// Everything the servers store. Days below 50 settled before each trimming server's cut.
const SERVER_ROWS: ReadonlyArray<Row> = [
  row(asus, "k-recent", { inbox: makeThreadInbox({ actor: kameron }), settledDay: 90 }),
  row(asus, "history-recent", { settledDay: 91 }),
  row(asus, "history-old-1", { settledDay: 10 }),
  row(asus, "history-old-2", { settledDay: 11 }),
  row(asus, "agent-history-old", { settledDay: 12, createdBy: "agent" }),
  row(asus, "jeff-old", { inbox: makeThreadInbox({ actor: jeff }), settledDay: 13 }),
  // Agent work with no owner takes its parent's founder, which every client holds (active).
  row(asus, "jeff-root", { inbox: makeThreadInbox({ actor: jeff }) }),
  row(asus, "agent-old", {
    inbox: makeThreadInbox({ actor: bot, routing: inboxRoutingFor("agents") }),
    settledDay: 14,
    parent: "jeff-root",
  }),
  // Pinned older threads stay in every snapshot, outside the Settled shelf.
  row(asus, "pinned-old", { settledDay: 15, pinned: true }),
  row(air, "air-history-old", { settledDay: 20 }),
  row(air, "air-history-recent", { settledDay: 92 }),
  row(air, "shared-old", {
    inbox: makeThreadInbox({ actor: kameron, routing: inboxRoutingFor("shared") }),
    settledDay: 21,
  }),
  row(air, "air-active", {}),
  row(cleared, "cleared-history-old", { settledDay: 22 }),
  row(cleared, "cleared-history-recent", { settledDay: 93 }),
  row(legacyLaptop, "laptop-history", { settledDay: 30 }),
  row(legacyLaptop, "laptop-kameron", {
    inbox: makeThreadInbox({ actor: kameron }),
    settledDay: 31,
  }),
];

const owner = (ownerFounder: Founder | null): MachineOwnerConfig => ({
  machineOwner: true,
  settings: { ownerFounder },
});
const SERVER_CONFIGS: ReadonlyMap<EnvironmentId, MachineOwnerConfig> = new Map([
  [asus, owner("kameron")],
  [air, owner("jeff")],
  [cleared, owner(null)],
  // A 0.1.9 server decodes `ownerFounder` as null without reporting it.
  [legacyLaptop, { settings: { ownerFounder: null } }],
]);
const TRIMMING = new Set([asus, air, cleared]);

const isOlder = (thread: Row) =>
  TRIMMING.has(thread.environmentId) && isOlderSettledThreadShell(thread.source, CUT_MS);

/** What each trimming server sends as `olderSettled`, grouped as the server groups it. */
function serverOlderSettled(withGroups: boolean): ReadonlyMap<EnvironmentId, OlderSettled> {
  const result = new Map<EnvironmentId, OlderSettled>();
  for (const environmentId of TRIMMING) {
    const rows = SERVER_ROWS.filter((thread) => thread.environmentId === environmentId);
    const senders = resolveThreadSenders(
      rows.map((thread) => ({
        key: thread.id,
        parentKey: thread.lineage.parentThreadId,
        inbox: thread.source.inbox,
        createdBy: thread.source.createdBy,
      })),
    );
    const older = rows.filter(isOlder);
    const groups = new Map<
      string,
      NonNullable<OrchestrationV2OlderSettledCount["groups"]>[number]
    >();
    for (const thread of older) {
      const sender = senders.get(thread.id)!;
      const group = {
        inbox: primaryInbox(thread.source.inbox),
        agentCreated: thread.source.createdBy === "agent",
        founder: sender.founder,
        byAgent: sender.byAgent,
      };
      const key = JSON.stringify(group);
      groups.set(key, { ...group, count: (groups.get(key)?.count ?? 0) + 1 });
    }
    const counts: ReadonlyArray<OrchestrationV2OlderSettledCount> =
      older.length === 0
        ? []
        : [
            {
              projectId: project,
              count: older.length,
              ...(withGroups ? { groups: [...groups.values()] } : {}),
            },
          ];
    result.set(environmentId, {
      before: DateTime.formatIso(DateTime.makeUnsafe(CUT_MS)),
      beforeMs: CUT_MS,
      ...olderSettledCountsOf(counts),
    });
  }
  return result;
}

/** One app's Settled shelf and list over the rows it holds, as the sidebar computes them. */
function sidebar(input: {
  readonly held: ReadonlyArray<Row>;
  readonly legacy: FounderByEnvironmentId;
  readonly olderSettled: ReadonlyMap<EnvironmentId, OlderSettled>;
  readonly filter: ThreadListFilter;
}) {
  const owners = resolveMachineOwners(SERVER_CONFIGS, input.legacy);
  const attributions = resolveThreadAttributions(input.held, owners);
  const attributionOf = (thread: Row): ThreadAttribution =>
    attributions.get(threadAttributionKey(thread)) ?? "unknown";
  const listed = input.held.filter((thread) =>
    matchesThreadListFilter(thread, input.filter, attributionOf(thread)),
  );
  const settled = listed.filter(
    (thread) => thread.source.settledOverride === "settled" && thread.source.pinnedAt === null,
  );
  const total = settledShelfTotal({
    olderSettled: (environmentId) => input.olderSettled.get(environmentId) ?? null,
    scopes: [...SERVER_CONFIGS.keys()].map((environmentId) => ({
      environmentId,
      projectIds: null,
    })),
    threads: listed,
    settledCount: settled.length,
    filter: {
      matches: (environmentId, group) =>
        matchesOlderSettledGroup(environmentId, group, input.filter, owners),
      coverage: (environmentId) => threadListFilterCoverage(environmentId, input.filter),
    },
  });
  return {
    attributions: new Map(
      input.held.map((thread) => [threadAttributionKey(thread), attributionOf(thread)]),
    ),
    listed: new Set(listed.map(threadAttributionKey)),
    total,
  };
}

// Every snapshot row: newer than the cut, pinned, or from a server that trims nothing.
const SNAPSHOT_ROWS = SERVER_ROWS.filter(
  (thread) => !isOlder(thread) || thread.source.pinnedAt !== null,
);
// One app saw only the snapshots; the other also loaded every older page, in another order.
const CLIENT_A = {
  held: SNAPSHOT_ROWS,
  // Wrong for every machine that reports an owner, and must not matter there.
  legacy: { [asus]: "jeff", [air]: "kameron", [cleared]: "kameron", [legacyLaptop]: "kameron" },
} as const;
const CLIENT_B = {
  held: [...SERVER_ROWS].reverse(),
  legacy: { [legacyLaptop]: "kameron" },
} as const;

const FILTERS: ReadonlyArray<readonly [string, ThreadListFilter]> = [
  ["All", { inboxes: InboxChoice.literals, hiddenEnvironmentIds: [], hiddenAttributions: [] }],
  [
    "Kameron + Agents",
    { inboxes: ["kameron", "agents"], hiddenEnvironmentIds: [], hiddenAttributions: [] },
  ],
  [
    "Jeff + Agents",
    { inboxes: ["jeff", "agents"], hiddenEnvironmentIds: [], hiddenAttributions: [] },
  ],
  ["Shared", { inboxes: ["shared"], hiddenEnvironmentIds: [], hiddenAttributions: [] }],
  [
    "From Kameron only",
    {
      inboxes: InboxChoice.literals,
      hiddenEnvironmentIds: [],
      hiddenAttributions: ["jeff", "jeff-agents", "unknown"],
    },
  ],
  [
    "From Jeff only",
    {
      inboxes: InboxChoice.literals,
      hiddenEnvironmentIds: [],
      hiddenAttributions: ["kameron", "kameron-agents", "unknown"],
    },
  ],
  [
    "Agents, Air hidden",
    { inboxes: ["agents"], hiddenEnvironmentIds: [air], hiddenAttributions: [] },
  ],
];

describe("one inbox across apps", () => {
  const olderSettled = serverOlderSettled(true);
  // An app holding every thread with no cut is the ground truth.
  const truthFor = (filter: ThreadListFilter) =>
    sidebar({ held: SERVER_ROWS, legacy: CLIENT_B.legacy, olderSettled: new Map(), filter });

  it.each(FILTERS)("%s: two apps list and count the same threads", (_name, filter) => {
    const a = sidebar({ ...CLIENT_A, olderSettled, filter });
    const b = sidebar({ ...CLIENT_B, olderSettled, filter });
    const truth = truthFor(filter);

    expect(a.total).toEqual(b.total);
    expect(a.total).toEqual({ count: truth.total.count, exact: true });
    // Rows both apps hold are listed and credited identically, and as the truth lists them.
    for (const thread of CLIENT_A.held) {
      const key = threadAttributionKey(thread);
      expect(a.listed.has(key)).toBe(b.listed.has(key));
      expect(a.listed.has(key)).toBe(truth.listed.has(key));
      expect(a.attributions.get(key)).toBe(b.attributions.get(key));
    }
  });

  it("credits history to the owner each machine reports, not the app's own map", () => {
    const filter = FILTERS[0]![1];
    const a = sidebar({ ...CLIENT_A, olderSettled, filter }).attributions;
    expect(a.get(`${asus}:history-recent`)).toBe("kameron");
    expect(a.get(`${air}:air-history-recent`)).toBe("jeff");
    // A cleared owner is reported as null, so the app's stale entry is ignored.
    expect(a.get(`${cleared}:cleared-history-recent`)).toBe("unknown");
    // Only a server too old to report an owner uses the app's map.
    expect(a.get(`${legacyLaptop}:laptop-history`)).toBe("kameron");
    expect(
      sidebar({ ...CLIENT_A, legacy: {}, olderSettled, filter }).attributions.get(
        `${legacyLaptop}:laptop-history`,
      ),
    ).toBe("unknown");
  });

  it("shows a lower bound, the same on every app, when a server sends totals only", () => {
    const totalsOnly = serverOlderSettled(false);
    const kameronInbox = FILTERS[1]![1];
    const a = sidebar({ ...CLIENT_A, olderSettled: totalsOnly, filter: kameronInbox });
    const b = sidebar({ ...CLIENT_B, olderSettled: totalsOnly, filter: kameronInbox });
    expect(a.total).toEqual(b.total);
    expect(a.total.exact).toBe(false);
    expect(a.total.count).toBeLessThanOrEqual(truthFor(kameronInbox).total.count);
    // Unfiltered, the totals are the whole answer.
    const all = FILTERS[0]![1];
    expect(sidebar({ ...CLIENT_A, olderSettled: totalsOnly, filter: all }).total).toEqual({
      count: truthFor(all).total.count,
      exact: true,
    });
  });
});
