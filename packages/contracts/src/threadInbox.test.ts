import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "./baseSchemas.ts";
import {
  makeThreadInbox,
  routeThreadInbox,
  matchesInboxView,
  founderInboxLane,
  compositeThreadKey,
} from "./threadInbox.ts";
const kameron = { kind: "human", id: "kameron" } as const;
const jeff = { kind: "human", id: "jeff" } as const;
const bot = { kind: "agent", id: "lead" } as const;
describe("shared fleet organizational inbox", () => {
  it("keeps host collisions distinct", () => {
    expect(compositeThreadKey("crown", "same")).not.toBe(compositeThreadKey("air", "same"));
    expect(compositeThreadKey("a:b", "c")).not.toBe(compositeThreadKey("a", "b:c"));
  });
  it("defaults founder-created work into that founder's inbox", () => {
    const k = makeThreadInbox({ actor: kameron });
    const j = makeThreadInbox({ actor: jeff });
    expect(matchesInboxView(k, "kameron")).toBe(true);
    expect(matchesInboxView(j, "kameron")).toBe(false);
    expect(matchesInboxView(j, "jeff")).toBe(true);
    expect(matchesInboxView(k, "jeff")).toBe(false);
    expect(matchesInboxView(j, "all")).toBe(true);
    expect(matchesInboxView(k, "all")).toBe(true);
  });
  it("hides bot-only work by default while All and Agents retain it", () => {
    const inbox = makeThreadInbox({ actor: bot });
    expect(matchesInboxView(inbox, "kameron")).toBe(false);
    expect(matchesInboxView(inbox, "jeff")).toBe(false);
    expect(matchesInboxView(inbox, "all")).toBe(true);
    expect(matchesInboxView(inbox, "agents")).toBe(true);
  });
  it("routes bot action and FYI assignments to either founder", () => {
    for (const id of ["kameron", "jeff"] as const) {
      const inbox = makeThreadInbox({ actor: bot, routing: { assignee: { kind: "human", id } } });
      expect(matchesInboxView(inbox, id)).toBe(true);
      expect(founderInboxLane(inbox, id)).toBe("action");
      expect(founderInboxLane(routeThreadInbox(inbox, { attentionKind: "FYI" }), id)).toBe("FYI");
      expect(matchesInboxView(inbox, "all")).toBe(true);
    }
  });
  it("explicit reassignment wins over origin and retains provenance", () => {
    const original = makeThreadInbox({
      actor: jeff,
      executorEnvironmentId: EnvironmentId.make("air"),
    });
    const assigned = routeThreadInbox(original, { assignee: kameron, owner: "kameron" });
    expect(matchesInboxView(assigned, "kameron")).toBe(true);
    expect(matchesInboxView(assigned, "jeff")).toBe(false);
    expect(assigned.origin).toEqual(jeff);
    expect(assigned.requestedBy).toEqual(jeff);
    expect(assigned.executorEnvironmentId).toEqual(original.executorEnvironmentId);
  });
  it("inherits parent routing for child work without changing its requester", () => {
    const parent = makeThreadInbox({ actor: jeff, routing: { attentionKind: "FYI" } });
    const child = makeThreadInbox({
      actor: bot,
      parent,
      executorEnvironmentId: EnvironmentId.make("r720"),
    });
    expect(child.owner).toBe("jeff");
    expect(child.assignee).toEqual(jeff);
    expect(child.requestedBy).toEqual(jeff);
    expect(child.origin).toEqual(bot);
    expect(founderInboxLane(child, "jeff")).toBe("FYI");
    expect(child.executorEnvironmentId).toBe("r720");
  });
  it("supports shared views and routing to neither founder", () => {
    const shared = makeThreadInbox({ actor: kameron, routing: { audience: "shared" } });
    expect(matchesInboxView(shared, "shared")).toBe(true);
    const neither = routeThreadInbox(shared, {
      owner: null,
      assignee: bot,
      audience: "agent-only",
      attentionKind: "background",
    });
    expect(matchesInboxView(neither, "kameron")).toBe(false);
    expect(matchesInboxView(neither, "jeff")).toBe(false);
    expect(matchesInboxView(neither, "all")).toBe(true);
  });
  it("keeps unclassified history visible in All without rewriting it", () => {
    expect(matchesInboxView(undefined, "all")).toBe(true);
    expect(matchesInboxView(undefined, "kameron")).toBe(false);
    expect(matchesInboxView(undefined, "jeff")).toBe(false);
    expect(founderInboxLane(undefined, "kameron")).toBe("unknown");
  });
});
