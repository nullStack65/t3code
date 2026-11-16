import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Organizational labels on the shared fleet. These never authorize access. */
export const Founder = Schema.Literals(["kameron", "jeff"]);
export type Founder = typeof Founder.Type;
export const InboxActor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("human"), id: Founder }),
  Schema.Struct({ kind: Schema.Literal("agent"), id: TrimmedNonEmptyString }),
]);
export type InboxActor = typeof InboxActor.Type;
export const ThreadInboxRouting = Schema.Struct({
  owner: Schema.NullOr(Founder),
  assignee: Schema.NullOr(InboxActor),
  audience: Schema.Literals(["kameron", "jeff", "shared", "agent-only"]),
  attentionKind: Schema.Literals(["action", "FYI", "background"]),
});
export type ThreadInboxRouting = typeof ThreadInboxRouting.Type;
export const ThreadInboxRoutingPatch = Schema.Struct({
  owner: Schema.optionalKey(ThreadInboxRouting.fields.owner),
  assignee: Schema.optionalKey(ThreadInboxRouting.fields.assignee),
  audience: Schema.optionalKey(ThreadInboxRouting.fields.audience),
  attentionKind: Schema.optionalKey(ThreadInboxRouting.fields.attentionKind),
});
export type ThreadInboxRoutingPatch = typeof ThreadInboxRoutingPatch.Type;
export const ThreadInbox = Schema.Struct({
  ...ThreadInboxRouting.fields,
  origin: Schema.NullOr(InboxActor),
  requestedBy: Schema.NullOr(InboxActor),
  actor: Schema.NullOr(InboxActor),
  executorEnvironmentId: Schema.NullOr(EnvironmentId),
});
export type ThreadInbox = typeof ThreadInbox.Type;
export const INBOX_CAPABILITY = "closura-founder-inbox-v2" as const;
export const InboxView = Schema.Literals(["kameron", "jeff", "shared", "agents", "all"]);
export type InboxView = typeof InboxView.Type;
export const compositeThreadKey = (environmentId: string, threadId: string) =>
  JSON.stringify([environmentId, threadId]);
export const InboxThreadRef = Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId });

export function makeThreadInbox(input: {
  readonly actor: InboxActor | null;
  readonly requestedBy?: InboxActor | null;
  readonly executorEnvironmentId?: EnvironmentId | null;
  readonly parent?: ThreadInbox | null;
  readonly routing?: ThreadInboxRoutingPatch;
}): ThreadInbox {
  const actor = input.actor;
  const routing = input.routing;
  const target = routing?.assignee?.kind === "human" ? routing.assignee.id : undefined;
  const owner =
    routing?.owner !== undefined
      ? routing.owner
      : (target ?? input.parent?.owner ?? (actor?.kind === "human" ? actor.id : null));
  const assignee =
    routing?.assignee !== undefined
      ? routing.assignee
      : (input.parent?.assignee ?? (owner ? { kind: "human" as const, id: owner } : actor));
  const audience = routing?.audience ?? target ?? input.parent?.audience ?? owner ?? "agent-only";
  return {
    owner,
    assignee,
    audience,
    attentionKind:
      routing?.attentionKind ??
      (target ? "action" : (input.parent?.attentionKind ?? (owner ? "action" : "background"))),
    origin: actor,
    actor,
    requestedBy: input.requestedBy ?? input.parent?.requestedBy ?? actor,
    executorEnvironmentId: input.executorEnvironmentId ?? null,
  };
}

/** Preserve immutable origin/requester/executor when routing an existing thread. */
export const routeThreadInbox = (
  inbox: ThreadInbox,
  routing: ThreadInboxRoutingPatch,
): ThreadInbox => ({
  ...inbox,
  ...routing,
  ...(routing.assignee?.kind === "human"
    ? {
        owner: routing.owner === undefined ? routing.assignee.id : routing.owner,
        audience: routing.audience ?? routing.assignee.id,
        attentionKind:
          routing.attentionKind ??
          (inbox.attentionKind === "background" ? "action" : inbox.attentionKind),
      }
    : {}),
});

export function founderInboxLane(inbox: ThreadInbox | null | undefined, founder: Founder) {
  if (!inbox) return "unknown";
  const assigned = inbox.assignee?.kind === "human" ? inbox.assignee.id : inbox.owner;
  if (inbox.audience === "agent-only" && inbox.assignee?.kind !== "human") return "hidden";
  if (assigned !== founder) return "hidden";
  return inbox.attentionKind;
}

/** All deliberately includes every thread, including unclassified history. */
export function matchesInboxView(inbox: ThreadInbox | null | undefined, view: InboxView) {
  if (view === "all") return true;
  if (view === "agents")
    return (
      inbox?.origin?.kind === "agent" ||
      inbox?.assignee?.kind === "agent" ||
      inbox?.audience === "agent-only"
    );
  if (view === "shared") return inbox?.audience === "shared";
  const lane = founderInboxLane(inbox, view);
  return lane === "action" || lane === "FYI";
}
