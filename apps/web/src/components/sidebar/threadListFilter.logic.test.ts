import { EnvironmentId, ProjectId, ThreadId, makeThreadInbox } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  changedThreadListFilters,
  sidebarFilterIconClass,
  inboxMenuOrder,
  matchesThreadListFilter,
  olderSettledFilterCounts,
  SIDEBAR_FILTER_OPTION_LABEL_CLASS,
  SIDEBAR_FILTER_POPUP_CLASS,
  threadListFilterBucket,
  threadListFilterCounts,
  threadListFilterOf,
  toggleFilterOption,
  toggleHiddenEnvironment,
} from "./threadListFilter.logic";

const laptop = EnvironmentId.make("laptop");
const crown = EnvironmentId.make("crown");
const thread = (
  environmentId: EnvironmentId,
  actor: Parameters<typeof makeThreadInbox>[0]["actor"],
  createdBy?: string,
) => ({
  environmentId,
  source: { inbox: actor === null ? null : makeThreadInbox({ actor }), createdBy },
});
const kameron = { kind: "human", id: "kameron" } as const;
const jeff = { kind: "human", id: "jeff" } as const;
const bot = { kind: "agent", id: "lead" } as const;

describe("thread list filter", () => {
  it("shows a founder their own and shared threads, in the environments they keep", () => {
    const filter = threadListFilterOf({ founderInboxOwner: "kameron" });
    const visible = (candidate: ReturnType<typeof thread>) =>
      matchesThreadListFilter(candidate, filter);
    expect(visible(thread(laptop, kameron))).toBe(true);
    expect(visible(thread(laptop, bot))).toBe(false);
    // Shared threads stay visible without opening the filter.
    expect(
      visible({
        environmentId: laptop,
        source: {
          inbox: makeThreadInbox({ actor: kameron, routing: { audience: "shared" } }),
          createdBy: undefined,
        },
      }),
    ).toBe(true);
    // Agent threads from before inbox routing count as Agents.
    expect(
      matchesThreadListFilter(thread(laptop, null, "agent"), { ...filter, inboxes: ["agents"] }),
    ).toBe(true);
    expect(visible(thread(laptop, jeff))).toBe(false);
    expect(visible(thread(laptop, null))).toBe(false);
    const hidingCrown = { ...filter, hiddenEnvironmentIds: [crown] };
    expect(matchesThreadListFilter(thread(crown, kameron), hidingCrown)).toBe(false);
    expect(matchesThreadListFilter(thread(laptop, kameron), hidingCrown)).toBe(true);
  });

  it.each(["jeff", "kameron"] as const)(
    "shows %s their personal and shared standing bots",
    (owner) => {
      const filter = threadListFilterOf({ founderInboxOwner: owner });
      const all = threadListFilterOf({});
      const visible = (audience: "kameron" | "jeff" | "shared", selected = filter) =>
        matchesThreadListFilter(
          {
            ...thread(laptop, bot),
            standing: {},
            source: {
              inbox: makeThreadInbox({
                actor: bot,
                routing: { audience, attentionKind: "background" },
              }),
            },
          },
          selected,
          undefined,
          owner,
        );
      const other = owner === "jeff" ? "kameron" : "jeff";
      expect(visible(owner)).toBe(true);
      expect(visible("shared")).toBe(true);
      expect(visible(other, all)).toBe(false);
      expect(visible("shared", { ...filter, inboxes: [owner] })).toBe(false);
    },
  );

  it("counts each section within the other sections' selection", () => {
    const finished = { runtime: { status: "completed" }, latestRun: { status: "completed" } };
    const threads = [
      { ...thread(laptop, kameron), ...finished, from: "kameron" as const },
      { ...thread(laptop, bot), ...finished, from: "kameron-agents" as const },
      { ...thread(crown, jeff), ...finished, from: "jeff" as const },
      { ...thread(crown, kameron), ...finished, from: "kameron" as const },
      { ...thread(laptop, kameron), ...finished, from: "unknown" as const },
    ];
    const counts = threadListFilterCounts(
      threads,
      { inboxes: ["kameron"], hiddenEnvironmentIds: [crown], hiddenAttributions: ["unknown"] },
      (candidate) => candidate.from,
    );
    expect(Object.fromEntries(counts.inboxes)).toEqual({
      kameron: { working: 0, done: 1, needsMe: 0, settled: 0 },
      agents: { working: 0, done: 1, needsMe: 0, settled: 0 },
    });
    expect(Object.fromEntries(counts.environments)).toEqual({
      laptop: { working: 0, done: 1, needsMe: 0, settled: 0 },
      crown: { working: 0, done: 1, needsMe: 0, settled: 0 },
    });
    expect(Object.fromEntries(counts.from)).toEqual({
      kameron: { working: 0, done: 1, needsMe: 0, settled: 0 },
      unknown: { working: 0, done: 1, needsMe: 0, settled: 0 },
    });
    expect(
      matchesThreadListFilter(
        threads[4]!,
        threadListFilterOf({ sidebarHiddenThreadAttributions: ["unknown"] }),
        "unknown",
      ),
    ).toBe(false);
    // Notifications pass no attribution, so the From section does not silence them.
    expect(
      matchesThreadListFilter(
        threads[4]!,
        threadListFilterOf({ sidebarHiddenThreadAttributions: ["unknown"] }),
      ),
    ).toBe(true);
  });

  it("tints a changed filter with an important primary color", () => {
    // SidebarMenuButton's `[&>svg]:text-[var(--sidebar-icon-color)]` beats a
    // plain text-primary on the icon, so the default class must not claim one.
    expect(sidebarFilterIconClass(false)).toBe("size-4");
    expect(sidebarFilterIconClass(true)).toBe("size-4 text-primary!");
  });

  it("reports only sections that differ from this device's default", () => {
    const environments = [laptop, crown];
    const unchanged = threadListFilterOf({ founderInboxOwner: "jeff" });
    expect(changedThreadListFilters(unchanged, "jeff", environments)).toEqual({
      inboxes: false,
      environments: false,
      from: false,
    });
    const reordered = { ...unchanged, inboxes: ["shared", "jeff"] as const };
    expect(changedThreadListFilters(reordered, "jeff", environments).inboxes).toBe(false);
    // A hidden environment that was since removed is not a visible filter.
    const removed = { ...unchanged, hiddenEnvironmentIds: [EnvironmentId.make("gone")] };
    expect(changedThreadListFilters(removed, "jeff", environments).environments).toBe(false);
    expect(
      changedThreadListFilters(
        { ...unchanged, hiddenEnvironmentIds: [crown] },
        "jeff",
        environments,
      ),
    ).toEqual({ inboxes: false, environments: true, from: false });
  });

  it("toggles in menu order and never unchecks the last option", () => {
    const order = inboxMenuOrder("jeff");
    expect(order).toEqual(["jeff", "shared", "agents", "kameron"]);
    expect(toggleFilterOption(["agents"], "jeff", order)).toEqual(["jeff", "agents"]);
    expect(toggleFilterOption(["jeff", "agents"], "jeff", order)).toEqual(["agents"]);
    expect(toggleFilterOption(["agents"], "agents", order)).toEqual(["agents"]);
    // An environment that has not loaded yet stays hidden when another one is toggled.
    const offline = EnvironmentId.make("offline");
    expect(toggleHiddenEnvironment([offline], crown, [laptop, crown])).toEqual([offline, crown]);
    expect(toggleHiddenEnvironment([offline, crown], crown, [laptop, crown])).toEqual([offline]);
    expect(toggleHiddenEnvironment([crown], laptop, [laptop, crown])).toEqual([crown]);
  });

  it("buckets working, done and needs-me the same way on every row", () => {
    const finished = { runtime: { status: "completed" }, latestRun: { status: "completed" } };
    const quiet = {
      ...thread(laptop, kameron),
      source: {
        inbox: makeThreadInbox({
          actor: kameron,
          routing: { attentionKind: "FYI", reason: "fyi" },
        }),
      },
    };
    const asked = {
      ...quiet,
      source: {
        inbox: {
          ...quiet.source.inbox,
          decisionRequest: {
            founder: "kameron" as const,
            kind: "decision" as const,
            question: "Ship it?",
            requestedAt: "2026-11-20T00:00:00.000Z",
          },
        },
      },
    };
    const attention = {
      ...thread(laptop, bot),
      ...finished,
      source: {
        inbox: makeThreadInbox({
          actor: bot,
          routing: {
            owner: "kameron",
            assignee: { kind: "human", id: "kameron" },
            audience: "kameron",
            attentionKind: "action",
            reason: "review",
          },
        }),
      },
    };
    const otherAsk = {
      ...thread(laptop, jeff),
      ...finished,
      source: {
        inbox: {
          ...makeThreadInbox({
            actor: jeff,
            routing: { attentionKind: "FYI", reason: "fyi" },
          }),
          decisionRequest: {
            founder: "jeff" as const,
            kind: "decision" as const,
            question: "Your call?",
            requestedAt: "2026-11-20T00:00:00.000Z",
          },
        },
      },
    };
    const fixtures = {
      queued: {
        ...quiet,
        runtime: { status: "queued" },
        latestRun: { status: "queued" },
      },
      running: {
        ...quiet,
        runtime: { status: "running" },
        latestRun: { status: "running" },
      },
      done: { ...quiet, ...finished },
      failed: {
        ...quiet,
        runtime: { status: "failed" },
        latestRun: { status: "failed" },
      },
      approval: {
        ...quiet,
        runtime: { status: "running" },
        latestRun: { status: "running" },
        hasPendingApprovals: true,
      },
      question: {
        ...quiet,
        runtime: { status: "waiting" },
        latestRun: { status: "waiting" },
        hasPendingUserInput: true,
      },
      decision: { ...asked, ...finished },
      attention,
      parked: {
        ...quiet,
        runtime: { status: "idle" },
        latestRun: { status: "completed" },
      },
      parkedAttention: {
        ...attention,
        runtime: { status: "idle" },
        latestRun: { status: "completed" },
      },
      settled: { ...quiet, ...finished, settledOverride: "settled" as const },
      otherFounder: otherAsk,
      unstarted: quiet,
    };
    expect(threadListFilterBucket(fixtures.queued, "kameron")).toBe("working");
    expect(threadListFilterBucket(fixtures.running, "kameron")).toBe("working");
    expect(threadListFilterBucket(fixtures.done, "kameron")).toBe("done");
    expect(threadListFilterBucket(fixtures.failed, "kameron")).toBe("done");
    expect(threadListFilterBucket(fixtures.approval, "kameron")).toBe("needsMe");
    expect(threadListFilterBucket(fixtures.question, "kameron")).toBe("needsMe");
    expect(threadListFilterBucket(fixtures.decision, "kameron")).toBe("needsMe");
    expect(threadListFilterBucket(fixtures.attention, "kameron")).toBe("needsMe");
    expect(threadListFilterBucket(fixtures.parked, "kameron")).toBe("working");
    expect(threadListFilterBucket(fixtures.parkedAttention, "kameron")).toBe("working");
    expect(threadListFilterBucket(fixtures.settled, "kameron")).toBe("settled");
    expect(threadListFilterBucket(fixtures.otherFounder, "kameron")).toBe("done");
    expect(threadListFilterBucket(fixtures.unstarted, "kameron")).toBeNull();

    const threads = Object.values(fixtures).map((candidate) => ({
      ...candidate,
      from: "kameron" as const,
    }));
    const counts = threadListFilterCounts(
      threads,
      {
        inboxes: ["kameron", "jeff", "agents", "shared"],
        hiddenEnvironmentIds: [],
        hiddenAttributions: [],
      },
      (candidate) => candidate.from,
      "kameron",
    );
    const kameronRow = { working: 4, done: 2, needsMe: 4, settled: 1 };
    const everyRow = { working: 4, done: 3, needsMe: 4, settled: 1 };
    expect(counts.inboxes.get("kameron")).toEqual(kameronRow);
    expect(counts.inboxes.get("jeff")).toEqual({ working: 0, done: 1, needsMe: 0, settled: 0 });
    expect(counts.environments.get(laptop)).toEqual(everyRow);
    expect(counts.from.get("kameron")).toEqual(everyRow);
  });

  it("counts older settled threads from the servers' groups instead of the loaded rows", () => {
    const beforeMs = Date.parse("2026-11-18T00:00:00.000Z");
    const lineage = {
      relationshipToParent: null,
      parentThreadId: null,
      rootThreadId: ThreadId.make("root"),
    };
    const settledRow = (environmentId: EnvironmentId, settledAt: string) => ({
      ...thread(environmentId, kameron),
      settledOverride: "settled" as const,
      source: {
        ...thread(environmentId, kameron).source,
        lineage,
        settledOverride: "settled" as const,
        settledAt: DateTime.makeUnsafe(settledAt),
      },
    });
    const group = (inbox: "kameron" | "jeff" | null, count: number, agentCreated = false) => ({
      inbox,
      agentCreated,
      founder: "kameron" as const,
      byAgent: false,
      count,
    });
    const project = ProjectId.make("app");
    const other = ProjectId.make("other");
    const older = new Map([
      [
        laptop,
        {
          before: new Date(beforeMs).toISOString(),
          beforeMs,
          counts: new Map([
            [project, 55],
            [other, 9],
          ]),
          groups: new Map([
            [
              project,
              [group("kameron", 40), group("jeff", 7), group(null, 5), group(null, 3, true)],
            ],
            [other, [group("kameron", 9)]],
          ]),
        },
      ],
      [
        crown,
        {
          before: new Date(beforeMs).toISOString(),
          beforeMs,
          counts: new Map([[project, 12]]),
          groups: null,
        },
      ],
    ]);
    const source = olderSettledFilterCounts(
      [
        { environmentId: laptop, projectIds: [project] },
        { environmentId: crown, projectIds: null },
      ],
      (environmentId) => older.get(environmentId) ?? null,
      {},
    );
    expect(source.lowerBound).toBe(true);
    const loaded = [
      settledRow(laptop, "2026-11-19T00:00:00.000Z"),
      settledRow(laptop, "2026-11-17T00:00:00.000Z"),
      settledRow(crown, "2026-11-17T00:00:00.000Z"),
    ];
    const counts = threadListFilterCounts(
      loaded.filter((row) => !source.covers(row)),
      threadListFilterOf({ founderInboxOwner: "kameron" }),
      () => "kameron" as const,
      "kameron",
      source.groups,
    );
    expect(counts.inboxes.get("kameron")?.settled).toBe(1 + 40 + 1);
    expect(counts.inboxes.get("jeff")?.settled).toBe(7);
    expect(counts.inboxes.get("agents")?.settled).toBe(3);
    expect(counts.environments.get(laptop)?.settled).toBe(1 + 40);
    expect(counts.environments.get(crown)?.settled).toBe(1);
    expect(counts.unclassified).toBe(5);
  });
});

describe("standing bots bypass the inbox and From checkboxes", () => {
  const persona = { name: "Infra" };
  const stuck = {
    environmentId: crown,
    standing: persona,
    archivedAt: null,
    runtime: { status: "running" },
    source: {
      inbox: makeThreadInbox({
        actor: bot,
        routing: {
          audience: "kameron",
          attentionKind: "background",
          owner: "kameron",
          assignee: kameron,
          reason: "fyi",
        },
      }),
      createdBy: "agent" as const,
    },
  };

  it("lists a Kameron-audience background standing bot for Kameron, never for Jeff", () => {
    const kameronFilter = {
      ...threadListFilterOf({ founderInboxOwner: "kameron" }),
      inboxes: ["kameron"] as const,
    };
    expect(matchesThreadListFilter(stuck, kameronFilter, "unknown")).toBe(true);
    const jeffFilter = {
      ...threadListFilterOf({ founderInboxOwner: "jeff" }),
      inboxes: ["jeff"] as const,
    };
    expect(matchesThreadListFilter(stuck, jeffFilter, "unknown")).toBe(false);
    // Even with every inbox checked, Kameron's private bot stays out of Jeff's list.
    expect(
      matchesThreadListFilter(
        stuck,
        { ...jeffFilter, inboxes: ["kameron", "jeff", "shared", "agents"] },
        "unknown",
      ),
    ).toBe(false);
    expect(
      matchesThreadListFilter(
        stuck,
        {
          inboxes: ["kameron", "jeff", "shared", "agents"],
          hiddenEnvironmentIds: [crown],
          hiddenAttributions: [],
        },
        "unknown",
      ),
    ).toBe(false);
    const kameronWithoutAgents = {
      ...threadListFilterOf({ founderInboxOwner: "kameron" }),
      inboxes: ["kameron", "shared"] as const,
    };
    // Background attention files the lane under Agents, so unchecking Agents hides it.
    expect(matchesThreadListFilter({ ...stuck, standing: null }, kameronWithoutAgents)).toBe(false);
    expect(matchesThreadListFilter(stuck, kameronWithoutAgents, "unknown")).toBe(true);
  });

  it("counts a running remote standing bot even when its inbox is unchecked", () => {
    const counts = threadListFilterCounts(
      [stuck],
      {
        inboxes: ["jeff"],
        hiddenEnvironmentIds: [],
        hiddenAttributions: ["unknown"],
        viewingFounder: "kameron",
      },
      () => "unknown",
      "kameron",
    );
    expect(counts.environments.get(crown)).toEqual({
      working: 1,
      done: 0,
      needsMe: 0,
      settled: 0,
    });
  });
});

describe("counts for an asymmetric founder view", () => {
  const filterOf = (viewingFounder: "kameron" | "jeff") => ({
    inboxes: ["kameron", "jeff", "shared", "agents"] as const,
    hiddenEnvironmentIds: [],
    hiddenAttributions: [],
    viewingFounder,
  });
  const running = { runtime: { status: "running" } };
  const entries = [
    { ...thread(crown, kameron), ...running },
    { ...thread(crown, jeff), ...running },
    {
      environmentId: crown,
      ...running,
      source: {
        inbox: makeThreadInbox({
          actor: kameron,
          routing: { owner: "kameron", audience: "agent-only", attentionKind: "background" },
        }),
      },
    },
  ];
  const total = (counts: ReturnType<typeof threadListFilterCounts>) =>
    Object.values(counts.environments.get(crown) ?? {}).reduce((sum, n) => sum + n, 0);

  it("leaves Kameron's private threads out of Jeff's counts", () => {
    const counts = threadListFilterCounts(entries, filterOf("jeff"), () => "unknown", "jeff");
    expect(total(counts)).toBe(1);
    expect(counts.inboxes.get("kameron")).toBeUndefined();
    expect(counts.inboxes.get("jeff")).toBeDefined();
  });

  it("keeps every thread in Kameron's counts", () => {
    const counts = threadListFilterCounts(entries, filterOf("kameron"), () => "unknown", "kameron");
    expect(total(counts)).toBe(3);
  });

  it("leaves Kameron's older settled groups out of Jeff's counts", () => {
    const group = (inbox: "kameron" | "jeff") => ({
      environmentId: crown,
      inbox,
      agentCreated: false,
      attribution: "unknown" as const,
      count: 4,
    });
    const groups = [group("kameron"), group("jeff")];
    const forJeff = threadListFilterCounts([], filterOf("jeff"), () => "unknown", "jeff", groups);
    const forKameron = threadListFilterCounts(
      [],
      filterOf("kameron"),
      () => "unknown",
      "kameron",
      groups,
    );
    expect(forJeff.environments.get(crown)?.settled).toBe(4);
    expect(forKameron.environments.get(crown)?.settled).toBe(8);
  });
});

describe("sidebar filter labels", () => {
  it("keeps the popover wide enough to show full inbox and environment names", () => {
    expect(SIDEBAR_FILTER_POPUP_CLASS).not.toContain("available-width");
    expect(SIDEBAR_FILTER_POPUP_CLASS).toContain("40rem");
    expect(SIDEBAR_FILTER_OPTION_LABEL_CLASS).not.toContain("truncate");
    expect(SIDEBAR_FILTER_OPTION_LABEL_CLASS).toContain("whitespace-nowrap");
    expect(SIDEBAR_FILTER_OPTION_LABEL_CLASS).toContain("min-w-[16rem]");
  });
});
