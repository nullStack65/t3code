import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "./baseSchemas.ts";
import { ClientSettingsSchema } from "./settings.ts";
import {
  ThreadDecisionAsk,
  makeThreadInbox,
  routeThreadInbox,
  matchesInboxView,
  matchesInboxFilter,
  effectiveInboxFilter,
  inboxOriginFor,
  creatorInboxOrigin,
  refusesUnenrolledSender,
  founderInboxLane,
  staysActiveWhileWorking,
  compositeThreadKey,
  agentLaunchInboxRouting,
  agentLaunchInboxError,
  inboxAfterStandingSet,
  agentInboxRoutingError,
  projectThreadInbox,
  inboxAfterFounderReply,
  inboxRoutingFor,
  isHiddenFromFounder,
  primaryInbox,
  withLegacyPeerInboxReason,
  type ThreadInboxRoutingPatch,
} from "./threadInbox.ts";
const decode = Schema.decodeUnknownSync(ClientSettingsSchema);
const encode = Schema.encodeSync(ClientSettingsSchema);
const kameron = { kind: "human", id: "kameron" } as const;
const jeff = { kind: "human", id: "jeff" } as const;
const bot = { kind: "agent", id: "lead" } as const;
const isThreadDecisionAsk = Schema.is(ThreadDecisionAsk);

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
  it("keeps All until a founder is chosen, then defaults to that founder plus Shared", () => {
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
    expect(filter).toEqual(["jeff", "shared"]);
    expect(matchesInboxFilter(makeThreadInbox({ actor: jeff }), filter)).toBe(true);
    expect(matchesInboxFilter(makeThreadInbox({ actor: bot }), filter)).toBe(false);
    expect(matchesInboxFilter(makeThreadInbox({ actor: kameron }), filter)).toBe(false);
    expect(
      matchesInboxFilter(
        makeThreadInbox({ actor: kameron, routing: { audience: "shared" } }),
        filter,
      ),
    ).toBe(true);
    expect(matchesInboxFilter(undefined, filter)).toBe(false);
    const picked = decode(encode({ ...jeffClient, founderInboxFilter: ["kameron", "shared"] }));
    expect([effectiveInboxFilter(picked), picked.founderInboxOwner]).toEqual([
      ["kameron", "shared"],
      "jeff",
    ]);
    // Agent work filed to another founder or Shared stays out of "Kameron + Agents".
    const mineAndAgents = ["kameron", "agents"] as const;
    // New agent routes to a founder need a reason. Routing without one is how lanes were filed
    // before `reason` existed; those show to that founder as FYI rather than vanishing.
    const filedToJeff = makeThreadInbox({
      actor: bot,
      routing: { ...inboxRoutingFor("jeff"), reason: "decision" },
    });
    const unreasoned = makeThreadInbox({ actor: bot, routing: inboxRoutingFor("jeff") });
    expect(primaryInbox(unreasoned)).toBe("jeff");
    expect(founderInboxLane(unreasoned, "jeff")).toBe("FYI");
    expect(founderInboxLane(unreasoned, "kameron")).toBe("hidden");
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
    for (const owner of ["jeff", "kameron"] as const) {
      expect(effectiveInboxFilter({ founderInboxOwner: owner })).toEqual([owner, "shared"]);
      expect(effectiveInboxFilter({ founderInboxOwner: owner, founderInboxFilter: [] })).toEqual([
        owner,
        "shared",
      ]);
      expect(
        effectiveInboxFilter(
          decode(encode({ ...upgraded, founderInboxOwner: owner, founderInboxFilter: [owner] })),
        ),
      ).toEqual([owner, "shared"]);
      expect(
        effectiveInboxFilter({ founderInboxOwner: owner, founderInboxFilter: ["agents"] }),
      ).toEqual(["agents"]);
    }
    // Every inbox is All, which keeps unclassified history.
    const every = ["shared", "jeff", "agents", "kameron"] as const;
    expect(matchesInboxFilter(undefined, every)).toBe(true);
    expect(matchesInboxFilter(undefined, every.slice(1))).toBe(false);
  });
  it("prefers a session founder over client settings and leaves legacy history discoverable", () => {
    expect(inboxOriginFor({})).toBeUndefined();
    for (const [bound, preference] of [
      [jeff, kameron],
      [kameron, jeff],
    ] as const) {
      expect(
        creatorInboxOrigin(preference, { founder: bound.id, deviceType: "mobile" }),
      ).toEqual(bound);
    }
    expect(creatorInboxOrigin(jeff, { founder: null, deviceType: "desktop" })).toEqual(jeff);
    expect(
      creatorInboxOrigin(undefined, { founder: null, deviceType: "mobile" }),
    ).toBeUndefined();
    expect(creatorInboxOrigin(bot, { founder: "jeff", deviceType: "bot" })).toEqual(bot);
    // The current device cannot safely supply a founder for existing unclassified history.
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
  it("files a person's new thread under their session's founder, never a guessed one", () => {
    const phone = { founder: null, deviceType: "mobile" } as const;
    const jeffPhone = { ...phone, founder: "jeff" } as const;
    // A session assigned in Connections files as its founder, whatever the client claims.
    expect(creatorInboxOrigin(undefined, jeffPhone)).toEqual(jeff);
    expect(creatorInboxOrigin(kameron, jeffPhone)).toEqual(jeff);
    expect(creatorInboxOrigin(bot, jeffPhone)).toEqual(jeff);
    // An unassigned session keeps the client's choice and is not filed under a guessed owner.
    expect(creatorInboxOrigin(kameron, phone)).toEqual(kameron);
    expect(creatorInboxOrigin(undefined, phone)).toBeUndefined();
    // A bot's claim is left to agent routing.
    expect(creatorInboxOrigin(bot, { founder: "kameron", deviceType: "bot" })).toEqual(bot);
  });
  it("refuses an unenrolled person's founder actions only when identity is required", () => {
    const phone = { founder: null, deviceType: "mobile" } as const;
    const unknown = { founder: null, deviceType: "unknown" } as const;
    const attributed = [
      "message.dispatch",
      "queued-run.edit",
      "runtime-request.respond",
      "thread.create",
    ];
    for (const command of attributed) {
      expect(refusesUnenrolledSender(true, command, phone)).toBe(true);
      // A sender the server could not read is refused, not waved through.
      expect(refusesUnenrolledSender(true, command, unknown)).toBe(true);
      expect(refusesUnenrolledSender(true, command, { ...phone, founder: "jeff" })).toBe(false);
      expect(refusesUnenrolledSender(true, command, { founder: null, deviceType: "bot" })).toBe(
        false,
      );
      expect(refusesUnenrolledSender(false, command, phone)).toBe(false);
    }
    expect(refusesUnenrolledSender(true, "thread.visit", phone)).toBe(false);
    expect(refusesUnenrolledSender(true, "thread.archive", phone)).toBe(false);
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
    const standing = { name: "Infra" };
    const standingBot = launched({ standing });
    expect(standingBot.audience).toBe("shared");
    expect(standingBot.attentionKind).toBe("FYI");
    expect(standingBot.reason).toBe("fyi");
    expect(agentLaunchInboxError({ standing })).toBeNull();
    expect(visibleIn(standingBot)).toEqual(["shared", "agents"]);
    // An explicit inbox still wins over the standing default.
    expect(launched({ standing, inbox: "agents" }).attentionKind).toBe("background");
    expect(launched({ standing, inbox: "kameron", inboxRouting: because }).audience).toBe(
      "kameron",
    );
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

  it("lifts background attention when a route leaves Agents for a founder or Shared", () => {
    const agents = makeThreadInbox({ actor: bot, routing: agentLaunchInboxRouting({}) });
    expect(agents.attentionKind).toBe("background");
    const toKameron = routeThreadInbox(agents, { audience: "kameron", reason: "fyi" });
    expect(toKameron.audience).toBe("kameron");
    expect(toKameron.attentionKind).toBe("FYI");
    expect(toKameron.assignee).toEqual(kameron);
    expect(toKameron.owner).toBe("kameron");
    expect(founderInboxLane(toKameron, "kameron")).toBe("FYI");
    expect(matchesInboxView(toKameron, "kameron")).toBe(true);
    expect(matchesInboxView(toKameron, "jeff")).toBe(false);
    const toShared = routeThreadInbox(agents, { audience: "shared", reason: "fyi" });
    expect([toShared.audience, toShared.attentionKind]).toEqual(["shared", "FYI"]);
    expect(matchesInboxView(toShared, "shared")).toBe(true);
    const kept = routeThreadInbox(agents, {
      audience: "kameron",
      attentionKind: "background",
      reason: "fyi",
    });
    expect(kept.attentionKind).toBe("background");
    const persona = { name: "CTO" };
    const refiled = inboxAfterStandingSet(agents, persona);
    expect(refiled?.audience).toBe("shared");
    expect(refiled?.attentionKind).toBe("FYI");
    expect(inboxAfterStandingSet(refiled, null)).toBe(refiled);
    const stuck = routeThreadInbox(agents, {
      audience: "kameron",
      attentionKind: "background",
      assignee: kameron,
      reason: "fyi",
    });
    const lifted = inboxAfterStandingSet(stuck, persona);
    expect(lifted?.audience).toBe("kameron");
    expect(lifted?.attentionKind).toBe("FYI");
    const already = makeThreadInbox({
      actor: kameron,
      routing: { ...inboxRoutingFor("kameron"), reason: "conversation" },
    });
    expect(inboxAfterStandingSet(already, persona)).toBe(already);
  });

  it("files an older linked environment's reason-less founder routes as FYI instead of failing", () => {
    // A peer from before `inboxRouting.reason` has no such field in its tools: rejecting the
    // route for a missing reason left its agent no way to succeed.
    const toKameron = { assignee: kameron } as const;
    const routed = (routing: ThreadInboxRoutingPatch) =>
      routeThreadInbox(makeThreadInbox({ actor: bot }), routing);
    expect(agentInboxRoutingError(routed(toKameron), toKameron)).toContain("inboxRouting.reason");

    const legacy = withLegacyPeerInboxReason({ inboxRouting: toKameron }, true);
    expect(legacy.inboxRouting).toEqual({ assignee: kameron, reason: "fyi" });
    expect(agentInboxRoutingError(routed(legacy.inboxRouting), legacy.inboxRouting)).toBeNull();
    expect(founderInboxLane(routed(legacy.inboxRouting), "kameron")).toBe("FYI");

    const launch = withLegacyPeerInboxReason({ inbox: "kameron" as const }, true);
    expect(agentLaunchInboxError(launch)).toBeNull();
    expect(
      founderInboxLane(
        makeThreadInbox({ actor: bot, routing: agentLaunchInboxRouting(launch) }),
        "kameron",
      ),
    ).toBe("FYI");

    // A current peer announces the feature and still must give a reason.
    expect(withLegacyPeerInboxReason({ inboxRouting: toKameron }, false).inboxRouting).toEqual(
      toKameron,
    );
    expect(
      agentLaunchInboxError(withLegacyPeerInboxReason({ inbox: "kameron" as const }, false)),
    ).toContain("inboxRouting.reason");
    // A reason the older peer did send, and a launch that names no inbox, are left alone.
    const reviewed = { inboxRouting: { assignee: kameron, reason: "review" as const } };
    expect(withLegacyPeerInboxReason(reviewed, true)).toBe(reviewed);
    const plain = { title: "x", inboxRouting: undefined };
    expect(withLegacyPeerInboxReason(plain, true)).toBe(plain);
    // A route that stays in Agents gets no reason stamped on it.
    for (const agentsOnly of [
      { inboxRouting: {} },
      { inboxRouting: { assignee: null } },
      { inbox: "agents" as const },
    ])
      expect(withLegacyPeerInboxReason(agentsOnly, true)).toBe(agentsOnly);
    // The shared inbox is a founder inbox too: filed as FYI, not rejected.
    expect(
      agentLaunchInboxError(withLegacyPeerInboxReason({ inbox: "shared" as const }, true)),
    ).toBeNull();
  });
  it("shows reason-less agent lanes only to the founder they were routed to, as FYI", () => {
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
        // Pre-reason lanes (audience = founder) keep showing; nothing else reason-less does.
        const expected = (founder: "kameron" | "jeff") => {
          if (inbox.audience === "agent-only" && inbox.assignee?.kind !== "human") return "hidden";
          const assigned = inbox.assignee?.kind === "human" ? inbox.assignee.id : inbox.owner;
          return assigned === founder && inbox.audience === founder ? "FYI" : "hidden";
        };
        expect([founderInboxLane(inbox, "kameron"), founderInboxLane(inbox, "jeff")]).toEqual([
          expected("kameron"),
          expected("jeff"),
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
    // Leaving Agents without an attention kind is FYI, the attention a standing bot uses.
    expect([toJeff.decisionRequest, toJeff.attentionKind, ...lanes(toJeff)]).toEqual([
      undefined,
      "FYI",
      "hidden",
      "FYI",
    ]);
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
    // A standing desk filed to Kameron is FYI until a decision or a runtime request is open.
    const desk = makeThreadInbox({
      actor: bot,
      routing: { ...inboxRoutingFor("kameron"), reason: "conversation" },
    });
    const deskNow = (inbox: typeof desk, pendingHumanRequest = false, standing = true) =>
      projectThreadInbox(inbox, { latestHumanMessageAt: null, pendingHumanRequest, standing });
    expect([deskNow(desk).attentionKind, ...lanes(deskNow(desk))]).toEqual([
      "FYI",
      "FYI",
      "hidden",
    ]);
    expect(matchesInboxView(deskNow(desk), "kameron")).toBe(true);
    expect(staysActiveWhileWorking(deskNow(desk), ["kameron"])).toBe(false);
    expect(deskNow(desk, false, false).attentionKind).toBe("action");
    expect([deskNow(desk, true).attentionKind, ...lanes(deskNow(desk, true))]).toEqual([
      "action",
      "action",
      "hidden",
    ]);
    const deskAsk = { ...desk, decisionRequest: asked.decisionRequest };
    expect([deskNow(deskAsk).attentionKind, ...lanes(deskNow(deskAsk))]).toEqual([
      "action",
      "action",
      "hidden",
    ]);
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
      expect([founderInboxLane(filed, id), filed.attentionKind, filed.reason]).toEqual([
        "FYI",
        "FYI",
        "conversation",
      ]);
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
    expect(child.audience).toBe("agent-only");
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

describe("joint sign-off", () => {
  const signOff = [
    { founder: "jeff" as const, signed: false },
    { founder: "kameron" as const, signed: false },
  ];
  const asked = {
    ...makeThreadInbox({ actor: bot, routing: inboxRoutingFor("shared") }),
    decisionRequest: {
      founder: "kameron" as const,
      kind: "decision" as const,
      question: "Ship it?",
      requestedAt: "2026-11-20T00:00:00.000Z",
      signOff,
    },
  };
  const reply = (
    founder: "kameron" | "jeff" | null,
    updatedAt: string | { epochMilliseconds: number } = "2026-11-20T00:00:01.000Z",
  ) => ({
    role: "user",
    createdBy: "user",
    sentBy: { founder },
    updatedAt,
  });

  it("decodes only a sign-off that lists each founder once", () => {
    const ask = {
      founder: "kameron",
      kind: "decision",
      question: "Ship it?",
    } as const;
    expect(
      isThreadDecisionAsk({
        ...ask,
        signOff: [
          { founder: "kameron", signed: false },
          { founder: "jeff", signed: true },
        ],
      }),
    ).toBe(true);
    expect(
      isThreadDecisionAsk({
        ...ask,
        signOff: [
          { founder: "kameron", signed: false },
          { founder: "kameron", signed: true },
        ],
      }),
    ).toBe(false);
  });

  it("lets each founder sign only themselves, and closes once both have", () => {
    const once = inboxAfterFounderReply(asked, reply("kameron"));
    expect(once).not.toBe(asked);
    expect(once?.decisionRequest?.signOff).toEqual([
      { founder: "kameron", signed: true },
      { founder: "jeff", signed: false },
    ]);
    expect(inboxAfterFounderReply(once, reply("kameron", "2026-11-20T00:00:02.000Z"))).toBe(once);
    expect(inboxAfterFounderReply(asked, reply(null))).toBe(asked);
    expect(
      inboxAfterFounderReply(
        asked,
        reply("jeff", { epochMilliseconds: Date.parse(asked.decisionRequest.requestedAt) }),
      ),
    ).toBe(asked);
    const both = inboxAfterFounderReply(once, reply("jeff", "2026-11-20T00:00:03.000Z"));
    expect(both?.decisionRequest).toBeUndefined();
    const plain = { ...asked, decisionRequest: { ...asked.decisionRequest, signOff: undefined } };
    const closed = projectThreadInbox(plain, {
      latestHumanMessageAt: "2026-11-20T00:00:02.000Z",
      pendingHumanRequest: false,
    });
    expect(closed.decisionRequest).toBeUndefined();
  });

  it("keeps a joint ask open for the founder who has not signed", () => {
    const signed = inboxAfterFounderReply(asked, reply("kameron"))!;
    const projected = projectThreadInbox(signed, {
      latestHumanMessageAt: "2026-11-20T00:00:05.000Z",
      pendingHumanRequest: false,
    });
    expect(projected.decisionRequest?.signOff?.[1]?.signed).toBe(false);
    expect([founderInboxLane(projected, "kameron"), founderInboxLane(projected, "jeff")]).toEqual([
      "hidden",
      "action",
    ]);
    expect([founderInboxLane(asked, "kameron"), founderInboxLane(asked, "jeff")]).toEqual([
      "action",
      "action",
    ]);
  });
});

describe("isHiddenFromFounder", () => {
  const inbox = (owner: "kameron" | "jeff" | null | undefined, audience: string | undefined) => ({
    owner,
    audience,
  });

  it("hides Kameron's private threads and bots from Jeff", () => {
    expect(isHiddenFromFounder(inbox("kameron", "kameron"), "jeff")).toBe(true);
    // Audience Kameron hides whoever owns it.
    expect(isHiddenFromFounder(inbox(null, "kameron"), "jeff")).toBe(true);
    expect(isHiddenFromFounder(inbox("jeff", "kameron"), "jeff")).toBe(true);
    expect(isHiddenFromFounder(inbox(undefined, "kameron"), "jeff")).toBe(true);
  });

  it("hides Kameron-owned threads filed neither Shared nor to Jeff", () => {
    expect(isHiddenFromFounder(inbox("kameron", "agent-only"), "jeff")).toBe(true);
    expect(isHiddenFromFounder(inbox("kameron", undefined), "jeff")).toBe(true);
  });

  it("keeps Kameron-owned threads filed Shared or to Jeff visible to Jeff", () => {
    expect(isHiddenFromFounder(inbox("kameron", "shared"), "jeff")).toBe(false);
    expect(isHiddenFromFounder(inbox("kameron", "jeff"), "jeff")).toBe(false);
  });

  it("keeps Jeff's, shared and unowned threads visible to Jeff", () => {
    expect(isHiddenFromFounder(inbox("jeff", "jeff"), "jeff")).toBe(false);
    expect(isHiddenFromFounder(inbox(null, "shared"), "jeff")).toBe(false);
    expect(isHiddenFromFounder(inbox(null, "agent-only"), "jeff")).toBe(false);
    expect(isHiddenFromFounder(inbox(null, undefined), "jeff")).toBe(false);
  });

  it("never hides a thread without an inbox", () => {
    expect(isHiddenFromFounder(undefined, "jeff")).toBe(false);
    expect(isHiddenFromFounder(null, "jeff")).toBe(false);
    expect(isHiddenFromFounder({}, "jeff")).toBe(false);
  });

  it("hides nothing from Kameron, so Jeff's private threads stay in his lists", () => {
    for (const entry of [
      inbox("jeff", "jeff"),
      inbox("kameron", "kameron"),
      inbox("kameron", "agent-only"),
      inbox("jeff", undefined),
      inbox(null, "shared"),
    ]) {
      expect(isHiddenFromFounder(entry, "kameron")).toBe(false);
    }
  });

  it("hides nothing from a client without a founder", () => {
    expect(isHiddenFromFounder(inbox("kameron", "kameron"), undefined)).toBe(false);
    expect(isHiddenFromFounder(inbox("kameron", "kameron"), null)).toBe(false);
  });
});
