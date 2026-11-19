// Real, anonymized inbox records must not lose founder-visible threads against the rule before
// PR #81, which hid every reason-less lane. A count drop is a regression unless the PR gives the
// founder's rule. Failing? Read docs/inbox-sync-verification.md first.
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { INBOX_SNAPSHOT } from "./__fixtures__/inboxSnapshot.ts";
import {
  Founder,
  ThreadInbox,
  founderInboxLane,
  primaryInbox,
  projectThreadInbox,
  type InboxActor,
} from "./threadInbox.ts";

const GUIDE = "docs/inbox-sync-verification.md";
const agent: InboxActor = { kind: "agent", id: "agent" };
const base = {
  owner: "kameron",
  assignee: agent,
  audience: "kameron",
  attentionKind: "FYI",
  origin: agent,
  requestedBy: agent,
  actor: agent,
  executorEnvironmentId: null,
} as const satisfies ThreadInbox;
const idle = { pendingHumanRequest: false, latestHumanMessageAt: null };

const visible = (lane: string) => lane === "action" || lane === "FYI";

/** The founder lane as shipped before PR #81 (commit 7ec797a64d^), kept as the baseline. */
const lanePreReasonRule = (inbox: ThreadInbox, founder: Founder) => {
  const assigned = inbox.assignee?.kind === "human" ? inbox.assignee.id : inbox.owner;
  if (inbox.audience === "agent-only" && inbox.assignee?.kind !== "human") return "hidden";
  if (assigned !== founder) return "hidden";
  return inbox.attentionKind;
};

describe("founder inbox upgrade safety", () => {
  it("shows a lane filed before reasons existed, settled or not", () => {
    // Agent origin, audience kameron, FYI, no reason: what every lane looked like before #81.
    expect(founderInboxLane(base, "kameron")).toBe("FYI");
    expect(founderInboxLane(base, "jeff")).toBe("hidden");
    expect(
      founderInboxLane({ ...base, assignee: { kind: "human", id: "kameron" } }, "kameron"),
    ).toBe("FYI");
    // Shown as FYI whatever attention it carried: nothing records that it still waits on anyone.
    expect(founderInboxLane({ ...base, attentionKind: "action" }, "kameron")).toBe("FYI");
  });

  it("keeps an agent-only child out of the founder inbox", () => {
    const child: ThreadInbox = { ...base, audience: "agent-only", attentionKind: "background" };
    expect([founderInboxLane(child, "kameron"), founderInboxLane(child, "jeff")]).toEqual([
      "hidden",
      "hidden",
    ]);
  });

  it("still lands a decision request in the asked founder's action lane", () => {
    const asked: ThreadInbox = {
      ...base,
      audience: "agent-only",
      attentionKind: "background",
      decisionRequest: {
        founder: "kameron",
        kind: "decision",
        question: "Which one?",
        requestedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    expect(founderInboxLane(projectThreadInbox(asked, idle), "kameron")).toBe("action");
  });

  it("does not lose visible threads per founder and environment against the previous rule", () => {
    const decode = Schema.decodeUnknownSync(Schema.NullOr(ThreadInbox));
    type Key = `${Founder}|${string}|${"settled" | "open"}`;
    const before = new Map<Key, number>();
    const after = new Map<Key, number>();
    const add = (counts: Map<Key, number>, key: Key, n: number) =>
      counts.set(key, (counts.get(key) ?? 0) + n);
    let children = 0;
    for (const shape of INBOX_SNAPSHOT) {
      const inbox = decode(shape.inbox);
      if (inbox === null) continue;
      expect(
        primaryInbox(inbox),
        `unclassified thread in the snapshot. See ${GUIDE}`,
      ).not.toBeNull();
      for (const founder of Founder.literals) {
        const key: Key = `${founder}|${shape.environment}|${shape.settled ? "settled" : "open"}`;
        if (visible(lanePreReasonRule(inbox, founder))) add(before, key, shape.count);
        const lane = founderInboxLane(projectThreadInbox(inbox, idle), founder);
        if (visible(lane)) {
          add(after, key, shape.count);
          if (!shape.topLevel) children += shape.count;
        }
      }
    }
    expect(before.size, "the snapshot must contain founder-visible lanes").toBeGreaterThan(0);
    for (const [key, was] of before) {
      expect(
        after.get(key) ?? 0,
        `${key}: ${was} visible threads before, fewer now. A drop is a regression unless the PR gives the founder's rule. See ${GUIDE}`,
      ).toBeGreaterThanOrEqual(was);
    }
    expect(children, `children appeared in a founder inbox. See ${GUIDE}`).toBe(0);
  });
});
