import { EnvironmentId, makeThreadInbox } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  changedThreadListFilters,
  inboxMenuOrder,
  matchesThreadListFilter,
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
  it("shows a founder their own and agent threads, in the environments they keep", () => {
    const filter = threadListFilterOf({ founderInboxOwner: "kameron" });
    const visible = (candidate: ReturnType<typeof thread>) =>
      matchesThreadListFilter(candidate, filter);
    expect(visible(thread(laptop, kameron))).toBe(true);
    expect(visible(thread(laptop, bot))).toBe(true);
    // Agent threads from before inbox routing count as Agents.
    expect(visible(thread(laptop, null, "agent"))).toBe(true);
    expect(visible(thread(laptop, jeff))).toBe(false);
    expect(visible(thread(laptop, null))).toBe(false);
    const hidingCrown = { ...filter, hiddenEnvironmentIds: [crown] };
    expect(matchesThreadListFilter(thread(crown, kameron), hidingCrown)).toBe(false);
    expect(matchesThreadListFilter(thread(laptop, kameron), hidingCrown)).toBe(true);
  });

  it("counts each section within the other section's selection", () => {
    const threads = [
      thread(laptop, kameron),
      thread(laptop, bot),
      thread(crown, jeff),
      thread(crown, kameron),
    ];
    const counts = threadListFilterCounts(threads, {
      inboxes: ["kameron"],
      hiddenEnvironmentIds: [crown],
    });
    expect(Object.fromEntries(counts.inboxes)).toEqual({ kameron: 1, agents: 1 });
    expect(Object.fromEntries(counts.environments)).toEqual({ laptop: 1, crown: 1 });
  });

  it("reports only sections that differ from this device's default", () => {
    const environments = [laptop, crown];
    const unchanged = threadListFilterOf({ founderInboxOwner: "jeff" });
    expect(changedThreadListFilters(unchanged, "jeff", environments)).toEqual({
      inboxes: false,
      environments: false,
    });
    const reordered = { ...unchanged, inboxes: ["agents", "jeff"] as const };
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
    ).toEqual({ inboxes: false, environments: true });
  });

  it("toggles in menu order and never unchecks the last option", () => {
    const order = inboxMenuOrder("jeff");
    expect(order).toEqual(["jeff", "agents", "kameron", "shared"]);
    expect(toggleFilterOption(["agents"], "jeff", order)).toEqual(["jeff", "agents"]);
    expect(toggleFilterOption(["jeff", "agents"], "jeff", order)).toEqual(["agents"]);
    expect(toggleFilterOption(["agents"], "agents", order)).toEqual(["agents"]);
    // An environment that has not loaded yet stays hidden when another one is toggled.
    const offline = EnvironmentId.make("offline");
    expect(toggleHiddenEnvironment([offline], crown, [laptop, crown])).toEqual([offline, crown]);
    expect(toggleHiddenEnvironment([offline, crown], crown, [laptop, crown])).toEqual([offline]);
    expect(toggleHiddenEnvironment([crown], laptop, [laptop, crown])).toEqual([crown]);
  });
});
