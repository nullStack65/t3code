// Founder inbox rules as properties over generated inboxes. SPEC is the plain-English list and
// names each test. Changing a line needs the founder's word and a note here.
// Failing? Read docs/inbox-sync-verification.md first.
import { it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";
import {
  Founder,
  InboxChoice,
  founderInboxLane,
  matchesInboxFilter,
  matchesInboxView,
  primaryInbox,
  projectThreadInbox,
  routeThreadInbox,
  type InboxActor,
  type ThreadInbox,
} from "./threadInbox.ts";

const founders = Founder.literals;
const human = (id: Founder): InboxActor => ({ kind: "human", id });
const agent: InboxActor = { kind: "agent", id: "agent" };
const REQUESTED_AT = "2026-01-01T00:00:00.000Z";

const shape = {
  origin: Schema.Literals(["human", "agent"]),
  owner: Schema.NullOr(Founder),
  assignee: Schema.Literals(["none", "kameron", "jeff", "agent"]),
  audience: Schema.Literals(["kameron", "jeff", "shared", "agent-only"]),
  attentionKind: Schema.Literals(["action", "FYI", "background"]),
  reason: Schema.Literals(["none", "conversation", "review", "decision", "approval", "fyi"]),
  ask: Schema.Literals(["none", "kameron", "jeff"]),
  pending: Schema.Boolean,
  founder: Founder,
};
type Shape = {
  [K in keyof typeof shape]: Schema.Schema.Type<(typeof shape)[K]>;
};

const assigneeOf = (assignee: Shape["assignee"]): InboxActor | null =>
  assignee === "none" ? null : assignee === "agent" ? agent : human(assignee);

const inboxOf = (s: Shape, { withAsk = true } = {}): ThreadInbox => ({
  owner: s.owner,
  assignee: assigneeOf(s.assignee),
  audience: s.audience,
  attentionKind: s.attentionKind,
  ...(s.reason === "none" ? {} : { reason: s.reason }),
  ...(withAsk && s.ask !== "none"
    ? {
        decisionRequest: {
          founder: s.ask,
          kind: "decision" as const,
          question: "Which one?",
          requestedAt: REQUESTED_AT,
        },
      }
    : {}),
  ...(s.pending ? { pendingHumanRequest: true } : {}),
  origin: s.origin === "agent" ? agent : human(s.founder),
  requestedBy: null,
  actor: null,
  executorEnvironmentId: null,
});

const SPEC = {
  1: "A top-level lane routed to a founder (audience, and owner or human assignee, is that founder, with action or FYI attention) is never hidden from them, with or without a reason. Every lane filed before `reason` existed has none; PR #81 hid them all.",
  2: "An agent-only child with no human assignee is never in a founder lane, except through an open decision request or a pending request on a thread that founder owns.",
  3: "Every classified thread lands in exactly one of a founder lane, Shared, or Agents, never zero.",
  4: "An open decision ask for a founder survives re-projection as that founder's action lane until a person writes after it. Routing itself ends an earlier ask on purpose.",
  5: "Settlement never moves a thread between lanes: the lane takes no settled input. threadInbox.upgrade.test.ts counts settled and unsettled threads alike.",
} as const;

describe("founder inbox invariants", () => {
  it.prop(`1: ${SPEC[1]}`, shape, (s) => {
    // Built routed: audience and owner are the founder, a human assignee is the founder, and the
    // attention is one a founder sees (background reports in Agents). Origin and reason vary.
    const base = inboxOf(s, { withAsk: false });
    const inbox: ThreadInbox = {
      ...base,
      owner: s.founder,
      audience: s.founder,
      assignee: s.assignee === "agent" || s.assignee === "none" ? base.assignee : human(s.founder),
      attentionKind: s.attentionKind === "background" ? "FYI" : s.attentionKind,
    };
    const lane = founderInboxLane(inbox, s.founder);
    expect(lane === "action" || lane === "FYI").toBe(true);
    expect(matchesInboxView(inbox, s.founder)).toBe(true);
  });

  it.prop(`2: ${SPEC[2]}`, shape, (s) => {
    const inbox: ThreadInbox = {
      ...inboxOf(s, { withAsk: false }),
      audience: "agent-only",
      assignee: s.assignee === "agent" ? agent : null,
    };
    for (const founder of founders) {
      const lane = founderInboxLane(inbox, founder);
      if (s.pending && inbox.owner === founder) expect(lane).toBe("action");
      else expect(lane).toBe("hidden");
    }
    expect(matchesInboxView(inbox, "agents")).toBe(true);
  });

  it.prop(`3: ${SPEC[3]}`, shape, (s) => {
    const inbox = inboxOf(s);
    const home = primaryInbox(inbox);
    expect(home).not.toBeNull();
    const matching = InboxChoice.literals.filter((choice) => matchesInboxFilter(inbox, [choice]));
    expect(matching).toEqual([home]);
  });

  it.prop(`4: ${SPEC[4]}`, shape, (s) => {
    const base = inboxOf(s, { withAsk: false });
    const routed = routeThreadInbox(base, { audience: s.audience, attentionKind: s.attentionKind });
    // Routing ends any earlier ask; a new one is not dropped by the projection that follows.
    expect(routed.decisionRequest).toBeUndefined();
    if (s.ask === "none") return;
    const asked: ThreadInbox = {
      ...routed,
      decisionRequest: {
        founder: s.ask,
        kind: "decision",
        question: "Which one?",
        requestedAt: REQUESTED_AT,
      },
    };
    const open = projectThreadInbox(asked, {
      pendingHumanRequest: false,
      latestHumanMessageAt: null,
    });
    expect(founderInboxLane(open, s.ask)).toBe("action");
    const before = projectThreadInbox(asked, {
      pendingHumanRequest: false,
      latestHumanMessageAt: "2025-12-31T00:00:00.000Z",
    });
    expect(founderInboxLane(before, s.ask)).toBe("action");
    const answered = projectThreadInbox(asked, {
      pendingHumanRequest: false,
      latestHumanMessageAt: "2026-01-02T00:00:00.000Z",
    });
    expect(answered.decisionRequest).toBeUndefined();
  });
});
