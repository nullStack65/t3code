import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const Founder = Schema.Literals(["kameron", "jeff"]);
export type Founder = typeof Founder.Type;
export const InboxActor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("human"), id: Founder }),
  Schema.Struct({ kind: Schema.Literal("agent"), id: TrimmedNonEmptyString }),
]);
export type InboxActor = typeof InboxActor.Type;
export const ThreadInboxRouting = Schema.Struct({
  assignee: InboxActor,
  audience: Schema.Literals(["kameron", "jeff", "shared", "agent-only"]),
  attentionKind: Schema.Literals(["action", "FYI", "background"]),
});
export type ThreadInboxRouting = typeof ThreadInboxRouting.Type;
export const ThreadInbox = Schema.Struct({
  ...ThreadInboxRouting.fields,
  requestedBy: InboxActor,
  actor: InboxActor,
  executorEnvironmentId: EnvironmentId,
});
export type ThreadInbox = typeof ThreadInbox.Type;
export const InboxIdentity = Schema.Struct({
  actor: InboxActor,
  requestedBy: Schema.optionalKey(InboxActor),
  delegatesTo: Schema.Array(Founder),
  operational: Schema.Boolean,
});
export type InboxIdentity = typeof InboxIdentity.Type;

export const INBOX_CAPABILITY = "closura-thread-inbox-v1" as const;
// JSON tuple encoding is injective even when an identifier contains a separator.
export const compositeThreadKey = (environmentId: string, threadId: string) =>
  JSON.stringify([environmentId, threadId]);
export const InboxThreadRef = Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId });

/** Only use with the subject verified by the destination's session authenticator. */
export const inboxIdentitySubject = (identity: InboxIdentity) =>
  `closura-inbox-v1:${JSON.stringify(identity)}`;
const decodeIdentity = Schema.decodeUnknownOption(Schema.fromJsonString(InboxIdentity));
export function inboxIdentityFromSubject(subject: string): InboxIdentity | null {
  if (!subject.startsWith("closura-inbox-v1:")) return null;
  const decoded = decodeIdentity(subject.slice("closura-inbox-v1:".length));
  // A malformed reserved identity must never fall back to host authority.
  return decoded._tag === "Some"
    ? decoded.value
    : { actor: { kind: "agent", id: "" }, delegatesTo: [], operational: false };
}
export function canReadInbox(identity: InboxIdentity, inbox: ThreadInbox | null | undefined) {
  if (identity.operational) return true;
  if (!inbox) return false;
  if (identity.actor.kind === "human") {
    return inbox.audience === identity.actor.id || inbox.audience === "shared";
  }
  if (inbox.audience !== "agent-only") {
    const audienceAllowed =
      inbox.audience === "shared"
        ? identity.delegatesTo.includes("kameron") && identity.delegatesTo.includes("jeff")
        : identity.delegatesTo.includes(inbox.audience);
    return (
      audienceAllowed &&
      ((inbox.actor.kind === "agent" && inbox.actor.id === identity.actor.id) ||
        (inbox.assignee.kind === "agent" && inbox.assignee.id === identity.actor.id))
    );
  }
  return (
    inbox.audience === "agent-only" &&
    ((inbox.assignee.kind === "agent" && inbox.assignee.id === identity.actor.id) ||
      (inbox.actor.kind === "agent" && inbox.actor.id === identity.actor.id))
  );
}
export function canRouteInbox(identity: InboxIdentity, routing: ThreadInboxRouting) {
  const founders = new Set<Founder>();
  if (routing.assignee.kind === "human") founders.add(routing.assignee.id);
  if (routing.audience === "shared") {
    founders.add("kameron");
    founders.add("jeff");
  } else if (routing.audience !== "agent-only") founders.add(routing.audience);
  return [...founders].every(
    (founder) =>
      (identity.actor.kind === "human" && identity.actor.id === founder) ||
      identity.delegatesTo.includes(founder),
  );
}
export function founderInboxLane(inbox: ThreadInbox | null | undefined, founder: Founder) {
  if (!inbox) return "unknown";
  if (inbox.audience === "agent-only") return "hidden";
  if (inbox.audience !== "shared" && inbox.audience !== founder) return "hidden";
  if (inbox.assignee.kind !== "human" || inbox.assignee.id !== founder) return "hidden";
  return inbox.attentionKind;
}

/** Defaults follow authenticated session subjects, never machine names or titles. */
export function defaultFounderInboxView(subjects: ReadonlyArray<string>): Founder | "operations" {
  const founders = new Set<Founder>();
  for (const subject of subjects) {
    const identity = inboxIdentityFromSubject(subject);
    if (identity?.actor.kind === "human") founders.add(identity.actor.id);
  }
  return founders.size === 1 ? [...founders][0]! : "operations";
}
