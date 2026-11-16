import { describe, expect, it } from "vitest";
import { EnvironmentId } from "./baseSchemas.ts";
import {
  canReadInbox,
  canRouteInbox,
  compositeThreadKey,
  founderInboxLane,
  inboxIdentityFromSubject,
  inboxIdentitySubject,
  type InboxIdentity,
  type ThreadInbox,
} from "./threadInbox.ts";
const human = (id: "kameron" | "jeff"): InboxIdentity => ({
  actor: { kind: "human", id },
  delegatesTo: [],
  operational: false,
});
const inbox: ThreadInbox = {
  requestedBy: { kind: "human", id: "kameron" },
  actor: { kind: "human", id: "kameron" },
  assignee: { kind: "human", id: "kameron" },
  audience: "kameron",
  attentionKind: "action",
  executorEnvironmentId: EnvironmentId.make("crown"),
};
describe("founder inbox policy", () => {
  it("keeps host collisions separate without ambiguous separators", () => {
    expect(compositeThreadKey("crown", "same")).not.toBe(compositeThreadKey("air", "same"));
    expect(compositeThreadKey("a:b", "c")).not.toBe(compositeThreadKey("a", "b:c"));
  });
  it("separates audience from assignment and attention", () => {
    expect(canReadInbox(human("kameron"), inbox)).toBe(true);
    expect(canReadInbox(human("jeff"), inbox)).toBe(false);
    expect(canReadInbox(human("jeff"), { ...inbox, audience: "shared" })).toBe(true);
    expect(founderInboxLane({ ...inbox, audience: "shared" }, "jeff")).toBe("hidden");
    expect(founderInboxLane({ ...inbox, attentionKind: "FYI" }, "kameron")).toBe("FYI");
    expect(founderInboxLane({ ...inbox, audience: "agent-only" }, "kameron")).toBe("hidden");
  });
  it("does not infer legacy provenance and confines operational visibility", () => {
    expect(founderInboxLane(null, "kameron")).toBe("unknown");
    expect(canReadInbox(human("kameron"), null)).toBe(false);
    expect(canReadInbox({ ...human("kameron"), operational: true }, null)).toBe(true);
    expect(canReadInbox(human("kameron"), { ...inbox, audience: "agent-only" })).toBe(false);
  });
  it("requires explicit cross-founder delegation including shared audiences", () => {
    const target = {
      ...inbox,
      assignee: { kind: "human" as const, id: "jeff" as const },
      audience: "jeff" as const,
    };
    expect(canRouteInbox(human("kameron"), target)).toBe(false);
    expect(canRouteInbox({ ...human("kameron"), delegatesTo: ["jeff"] }, target)).toBe(true);
    expect(canRouteInbox(human("kameron"), { ...inbox, audience: "shared" })).toBe(false);
  });
  it("round-trips signed-subject identity and fails closed for malformed reserved subjects", () => {
    expect(inboxIdentityFromSubject(inboxIdentitySubject(human("jeff")))).toEqual(human("jeff"));
    expect(inboxIdentityFromSubject("one-time-token")).toBeNull();
    const malformed = inboxIdentityFromSubject("closura-inbox-v1:invalid");
    expect(malformed).not.toBeNull();
    expect(canReadInbox(malformed!, inbox)).toBe(false);
  });
});
