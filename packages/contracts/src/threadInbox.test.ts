import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "./baseSchemas.ts";
import { ClientSettingsSchema } from "./settings.ts";
import {
  makeThreadInbox,
  routeThreadInbox,
  matchesInboxView,
  effectiveInboxView,
  inboxOriginFor,
  founderInboxLane,
  compositeThreadKey,
  agentLaunchInboxRouting,
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
  it("keeps All until a founder is chosen, then defaults to that founder's view", () => {
    const decode = Schema.decodeUnknownSync(ClientSettingsSchema);
    const encode = Schema.encodeSync(ClientSettingsSchema);
    const upgraded = decode({ notificationMode: "off" });
    // Any later settings write saves the whole snapshot; it must not record an unmade choice.
    const resaved = encode(decode(encode(upgraded)));
    expect(["founderInboxView", "founderInboxOwner"].filter((key) => key in resaved)).toEqual([]);
    expect(effectiveInboxView(upgraded)).toBe("all");
    expect(matchesInboxView(undefined, effectiveInboxView(upgraded))).toBe(true);
    const jeffClient = decode(encode({ ...upgraded, founderInboxOwner: "jeff" }));
    const view = effectiveInboxView(jeffClient);
    expect(view).toBe("jeff");
    expect(matchesInboxView(makeThreadInbox({ actor: jeff }), view)).toBe(true);
    expect(matchesInboxView(makeThreadInbox({ actor: kameron }), view)).toBe(false);
    expect(matchesInboxView(makeThreadInbox({ actor: bot }), view)).toBe(false);
    expect(matchesInboxView(makeThreadInbox({ actor: bot }), "agents")).toBe(true);
    expect(matchesInboxView(undefined, "all")).toBe(true);
    for (const picked of ["jeff", "kameron", "shared", "agents", "all"] as const) {
      const saved = decode(encode({ ...jeffClient, founderInboxView: picked }));
      expect([effectiveInboxView(saved), saved.founderInboxOwner]).toEqual([picked, "jeff"]);
    }
  });
  it("attributes new work only to a chosen founder and leaves unchosen work in All", () => {
    expect(inboxOriginFor({})).toBeUndefined();
    // The server creates no inbox for a human thread without an origin, like legacy history.
    for (const view of ["kameron", "jeff", "agents", "shared"] as const) {
      expect(matchesInboxView(undefined, view)).toBe(false);
    }
    expect(matchesInboxView(undefined, effectiveInboxView({}))).toBe(true);
    const origin = inboxOriginFor({ founderInboxOwner: "jeff" });
    expect(origin).toEqual(jeff);
    const inbox = makeThreadInbox({ actor: origin ?? null });
    expect([matchesInboxView(inbox, "jeff"), matchesInboxView(inbox, "kameron")]).toEqual([
      true,
      false,
    ]);
  });
  it("files agent launches in Agents unless the agent picks an inbox", () => {
    // A launch from a thread in Kameron's inbox no longer copies that routing.
    const launched = (choice: Parameters<typeof agentLaunchInboxRouting>[0]) =>
      makeThreadInbox({ actor: bot, routing: agentLaunchInboxRouting(choice) });
    const views = ["kameron", "jeff", "shared", "agents"] as const;
    const visibleIn = (inbox: ReturnType<typeof launched>) =>
      views.filter((view) => matchesInboxView(inbox, view));
    expect(visibleIn(launched({}))).toEqual(["agents"]);
    expect(visibleIn(launched({ inbox: "kameron" }))).toEqual(["kameron", "agents"]);
    expect(visibleIn(launched({ inbox: "jeff" }))).toEqual(["jeff", "agents"]);
    expect(visibleIn(launched({ inbox: "shared" }))).toEqual(["shared", "agents"]);
    expect(launched({ inbox: "kameron" }).origin).toEqual(bot);
    const explicit = launched({
      inbox: "kameron",
      inboxRouting: { assignee: { kind: "human", id: "jeff" } },
    });
    expect(visibleIn(explicit)).toEqual(["jeff", "agents"]);
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

it("keeps unassigned agent-only action out of both founder inboxes", () => {
  const inbox = makeThreadInbox({
    actor: bot,
    routing: { owner: null, assignee: null, attentionKind: "action" },
  });
  expect(matchesInboxView(inbox, "kameron")).toBe(false);
  expect(matchesInboxView(inbox, "jeff")).toBe(false);
  expect(matchesInboxView(inbox, "agents")).toBe(true);
  expect(matchesInboxView(inbox, "all")).toBe(true);
  const assigned = routeThreadInbox(inbox, { owner: "jeff", assignee: jeff });
  expect(matchesInboxView(assigned, "jeff")).toBe(true);
  expect(matchesInboxView(assigned, "kameron")).toBe(false);
});

it("keeps founder-owned agent-only children out of founder inboxes", () => {
  const parent = makeThreadInbox({ actor: jeff });
  const child = makeThreadInbox({
    actor: bot,
    parent,
    routing: { audience: "agent-only", assignee: bot, attentionKind: "action" },
  });
  expect(child.owner).toBe("jeff");
  expect(matchesInboxView(child, "kameron")).toBe(false);
  expect(matchesInboxView(child, "jeff")).toBe(false);
  expect(matchesInboxView(child, "agents")).toBe(true);
  expect(matchesInboxView(child, "all")).toBe(true);
  const assigned = routeThreadInbox(child, { assignee: jeff });
  expect(matchesInboxView(assigned, "jeff")).toBe(true);
  expect(matchesInboxView(assigned, "kameron")).toBe(false);
});
