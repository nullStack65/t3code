import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "./baseSchemas.ts";
import { ClientSettingsSchema } from "./settings.ts";
import {
  makeThreadInbox,
  routeThreadInbox,
  matchesInboxView,
  matchesInboxFilter,
  effectiveInboxFilter,
  inboxOriginFor,
  founderInboxLane,
  staysActiveWhileWorking,
  compositeThreadKey,
  agentLaunchInboxRouting,
  agentLaunchInboxError,
  agentInboxRoutingError,
  projectThreadInbox,
  inboxRoutingFor,
  primaryInbox,
  type ThreadInboxRoutingPatch,
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
  it("keeps All until a founder is chosen, then defaults to that founder plus Agents", () => {
    const decode = Schema.decodeUnknownSync(ClientSettingsSchema);
    const encode = Schema.encodeSync(ClientSettingsSchema);
    // Settings saved by the single-choice selector still decode; that choice is not carried over.
    const upgraded = decode({ notificationMode: "off", founderInboxView: "all" });
    // Any later settings write saves the whole snapshot; it must not record an unmade choice.
    const resaved = encode(decode(encode(upgraded)));
    expect(
      ["founderInboxView", "founderInboxFilter", "founderInboxOwner"].filter(
        (key) => key in resaved,
      ),
    ).toEqual([]);
    expect(matchesInboxFilter(undefined, effectiveInboxFilter(upgraded))).toBe(true);
    const jeffClient = decode(encode({ ...upgraded, founderInboxOwner: "jeff" }));
    const filter = effectiveInboxFilter(jeffClient);
    expect(filter).toEqual(["jeff", "agents"]);
    expect(matchesInboxFilter(makeThreadInbox({ actor: jeff }), filter)).toBe(true);
    expect(matchesInboxFilter(makeThreadInbox({ actor: bot }), filter)).toBe(true);
    expect(matchesInboxFilter(makeThreadInbox({ actor: kameron }), filter)).toBe(false);
    expect(matchesInboxFilter(undefined, filter)).toBe(false);
    const picked = decode(encode({ ...jeffClient, founderInboxFilter: ["kameron", "shared"] }));
    expect([effectiveInboxFilter(picked), picked.founderInboxOwner]).toEqual([
      ["kameron", "shared"],
      "jeff",
    ]);
    // Agent work filed to another founder or Shared stays out of "Kameron + Agents".
    const mineAndAgents = ["kameron", "agents"] as const;
    // An agent files work to a founder only with a reason; without one it stays in Agents.
    const filedToJeff = makeThreadInbox({
      actor: bot,
      routing: { ...inboxRoutingFor("jeff"), reason: "decision" },
    });
    const unreasoned = makeThreadInbox({ actor: bot, routing: inboxRoutingFor("jeff") });
    expect(primaryInbox(unreasoned)).toBe("agents");
    const sharedByKameron = makeThreadInbox({ actor: kameron, routing: { audience: "shared" } });
    expect(matchesInboxFilter(filedToJeff, mineAndAgents)).toBe(false);
    expect(matchesInboxFilter(filedToJeff, ["jeff"])).toBe(true);
    expect(matchesInboxFilter(sharedByKameron, mineAndAgents)).toBe(false);
    expect(matchesInboxFilter(sharedByKameron, ["shared"])).toBe(true);
    const filedToKameron = makeThreadInbox({
      actor: bot,
      routing: { ...inboxRoutingFor("kameron"), reason: "review" },
    });
    expect(matchesInboxFilter(filedToKameron, ["kameron"])).toBe(true);
    expect(matchesInboxFilter(filedToKameron, ["agents"])).toBe(false);
    expect(effectiveInboxFilter({ founderInboxOwner: "jeff", founderInboxFilter: [] })).toEqual([
      "jeff",
      "agents",
    ]);
    // Every inbox is All, which keeps unclassified history.
    const every = ["shared", "jeff", "agents", "kameron"] as const;
    expect(matchesInboxFilter(undefined, every)).toBe(true);
    expect(matchesInboxFilter(undefined, every.slice(1))).toBe(false);
  });
  it("attributes new work only to a chosen founder and leaves unchosen work in All", () => {
    expect(inboxOriginFor({})).toBeUndefined();
    // The server creates no inbox for a human thread without an origin, like legacy history.
    for (const view of ["kameron", "jeff", "agents", "shared"] as const) {
      expect(matchesInboxView(undefined, view)).toBe(false);
    }
    expect(matchesInboxFilter(undefined, effectiveInboxFilter({}))).toBe(true);
    const origin = inboxOriginFor({ founderInboxOwner: "jeff" });
    expect(origin).toEqual(jeff);
    const inbox = makeThreadInbox({ actor: origin ?? null });
    expect([matchesInboxView(inbox, "jeff"), matchesInboxView(inbox, "kameron")]).toEqual([
      true,
      false,
    ]);
  });
  it("files agent launches in Agents unless the agent picks an inbox with a reason", () => {
    // A launch from a thread in Kameron's inbox no longer copies that routing.
    const launched = (choice: Parameters<typeof agentLaunchInboxRouting>[0]) =>
      makeThreadInbox({ actor: bot, routing: agentLaunchInboxRouting(choice) });
    const views = ["kameron", "jeff", "shared", "agents"] as const;
    const visibleIn = (inbox: ReturnType<typeof launched>) =>
      views.filter((view) => matchesInboxView(inbox, view));
    const because = { reason: "conversation" } as const;
    expect(visibleIn(launched({}))).toEqual(["agents"]);
    expect(agentLaunchInboxError({})).toBeNull();
    for (const inbox of ["kameron", "jeff", "shared"] as const) {
      expect(agentLaunchInboxError({ inbox })).toContain("request_decision");
      expect(agentLaunchInboxError({ inbox, inboxRouting: because })).toBeNull();
    }
    expect(visibleIn(launched({ inbox: "kameron", inboxRouting: because }))).toEqual([
      "kameron",
      "agents",
    ]);
    expect(visibleIn(launched({ inbox: "jeff", inboxRouting: because }))).toEqual([
      "jeff",
      "agents",
    ]);
    expect(visibleIn(launched({ inbox: "shared", inboxRouting: because }))).toEqual([
      "shared",
      "agents",
    ]);
    expect(launched({ inbox: "kameron" }).origin).toEqual(bot);
    const explicit = launched({
      inbox: "kameron",
      inboxRouting: { assignee: { kind: "human", id: "jeff" }, reason: "review" },
    });
    expect(visibleIn(explicit)).toEqual(["jeff", "agents"]);
    const quieter = launched({ inbox: "kameron", inboxRouting: { reason: "fyi" } });
    expect(visibleIn(quieter)).toEqual(["kameron", "agents"]);
    expect(founderInboxLane(quieter, "kameron")).toBe("FYI");
  });
  it("never files reason-less agent work into a founder's lane", () => {
    const people = [null, kameron, jeff] as const;
    const patches: ThreadInboxRoutingPatch[] = [{}];
    for (const owner of [null, "kameron", "jeff"] as const)
      for (const assignee of [...people, bot])
        for (const audience of ["kameron", "jeff", "shared", "agent-only"] as const)
          for (const attentionKind of ["action", "FYI", "background"] as const)
            patches.push({ owner, assignee, audience, attentionKind });
    for (const routing of patches) {
      for (const parent of [undefined, makeThreadInbox({ actor: kameron })]) {
        const inbox = makeThreadInbox({ actor: bot, routing, ...(parent ? { parent } : {}) });
        expect([founderInboxLane(inbox, "kameron"), founderInboxLane(inbox, "jeff")]).toEqual([
          "hidden",
          "hidden",
        ]);
        expect(agentInboxRoutingError(inbox, routing) === null).toBe(
          inbox.audience === "agent-only" && inbox.assignee?.kind !== "human",
        );
      }
    }
  });
  it("holds a thread in a founder's lane only while it waits on them", () => {
    const work = makeThreadInbox({ actor: bot, routing: agentLaunchInboxRouting({}) });
    const lanes = (inbox: typeof work) => [
      founderInboxLane(inbox, "kameron"),
      founderInboxLane(inbox, "jeff"),
    ];
    expect(lanes(work)).toEqual(["hidden", "hidden"]);
    const asked = {
      ...work,
      decisionRequest: {
        founder: "kameron",
        kind: "approval",
        question: "Send this draft?",
        requestedAt: "2026-11-18T21:00:00.000Z",
      },
    } as const;
    const project = (latestHumanMessageAt: string | null, pendingHumanRequest = false) =>
      projectThreadInbox(asked, { latestHumanMessageAt, pendingHumanRequest });
    expect(lanes(project(null))).toEqual(["action", "hidden"]);
    // Moving the thread ends the ask, so it leaves the asked founder's lane.
    const toAgents = routeThreadInbox(asked, agentLaunchInboxRouting({}));
    expect([toAgents.decisionRequest, ...lanes(toAgents)]).toEqual([undefined, "hidden", "hidden"]);
    const toJeff = routeThreadInbox(asked, { assignee: { kind: "human", id: "jeff" } });
    expect([toJeff.decisionRequest, ...lanes(toJeff)]).toEqual([undefined, "hidden", "action"]);
    expect(lanes(project("2026-11-18T20:59:00.000Z"))).toEqual(["action", "hidden"]);
    const answered = project("2026-11-18T21:01:00.000Z");
    expect(answered.decisionRequest).toBeUndefined();
    expect(lanes(answered)).toEqual(["hidden", "hidden"]);
    expect(matchesInboxView(answered, "agents")).toBe(true);
    // A runtime request surfaces only to the thread's owner.
    expect(lanes(project("2026-11-18T21:01:00.000Z", true))).toEqual(["hidden", "hidden"]);
    const owned = makeThreadInbox({
      actor: bot,
      routing: {
        owner: "jeff",
        assignee: bot,
        audience: "agent-only",
        attentionKind: "background",
      },
    });
    const waiting = projectThreadInbox(owned, {
      latestHumanMessageAt: null,
      pendingHumanRequest: true,
    });
    expect(lanes(owned)).toEqual(["hidden", "hidden"]);
    expect(lanes(waiting)).toEqual(["hidden", "action"]);
    expect(
      lanes(
        projectThreadInbox(waiting, { latestHumanMessageAt: null, pendingHumanRequest: false }),
      ),
    ).toEqual(["hidden", "hidden"]);
    // A founder's own conversation stays in their lane while it waits on them.
    const conversation = makeThreadInbox({ actor: kameron });
    expect(
      lanes(
        projectThreadInbox(conversation, {
          latestHumanMessageAt: null,
          pendingHumanRequest: false,
        }),
      ),
    ).toEqual(["action", "hidden"]);
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
      const routing = { assignee: { kind: "human", id }, reason: "review" } as const;
      const inbox = makeThreadInbox({ actor: bot, routing });
      expect(matchesInboxView(inbox, id)).toBe(true);
      expect(founderInboxLane(inbox, id)).toBe("action");
      expect(
        founderInboxLane(routeThreadInbox(inbox, { attentionKind: "FYI", reason: "review" }), id),
      ).toBe("FYI");
      expect(matchesInboxView(inbox, "all")).toBe(true);
      // A person filing agent work into their inbox needs no reason; a route to Agents drops it.
      const filed = routeThreadInbox(makeThreadInbox({ actor: bot }), {
        assignee: { kind: "human", id },
      });
      expect([founderInboxLane(filed, id), filed.reason]).toEqual(["action", "conversation"]);
      const returned = routeThreadInbox(filed, {
        owner: null,
        assignee: null,
        audience: "agent-only",
        attentionKind: "background",
      });
      expect([founderInboxLane(returned, id), returned.reason]).toEqual(["hidden", undefined]);
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
    // Child work an agent started reports in Agents, not the requester's inbox.
    expect(founderInboxLane(child, "jeff")).toBe("hidden");
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

describe("staysActiveWhileWorking", () => {
  const actionForKameron = makeThreadInbox({
    actor: bot,
    routing: { assignee: kameron, reason: "review" },
  });

  it("keeps a thread waiting on a shown founder in the active list", () => {
    expect(founderInboxLane(actionForKameron, "kameron")).toBe("action");
    expect(staysActiveWhileWorking(actionForKameron, ["kameron", "agents"])).toBe(true);
    expect(staysActiveWhileWorking(actionForKameron, ["kameron", "jeff", "shared", "agents"])).toBe(
      true,
    );
  });

  it("leaves it on the Working shelf when that founder's inbox is not shown", () => {
    expect(staysActiveWhileWorking(actionForKameron, ["jeff", "agents"])).toBe(false);
    expect(staysActiveWhileWorking(actionForKameron, ["agents"])).toBe(false);
    expect(staysActiveWhileWorking(undefined, ["kameron"])).toBe(false);
  });

  it("does not hold FYI threads or unrouted agent work active", () => {
    const fyi = routeThreadInbox(actionForKameron, { attentionKind: "FYI", reason: "review" });
    expect(staysActiveWhileWorking(fyi, ["kameron"])).toBe(false);
    expect(staysActiveWhileWorking(makeThreadInbox({ actor: bot }), ["kameron"])).toBe(false);
  });
});
