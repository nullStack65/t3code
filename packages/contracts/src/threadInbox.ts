import * as Schema from "effect/Schema";
import { EnvironmentId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

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
/** Why a founder or the shared inbox holds the thread. Agents must give one to file it there. */
export const InboxReason = Schema.Literals([
  "conversation",
  "review",
  "decision",
  "approval",
  "fyi",
]).annotate({
  description:
    "Why a founder must see it ('conversation': they work through it with you). Agents need one to file outside Agents.",
});
export type InboxReason = typeof InboxReason.Type;
export const ThreadInboxRoutingPatch = Schema.Struct({
  owner: Schema.optionalKey(ThreadInboxRouting.fields.owner),
  assignee: Schema.optionalKey(ThreadInboxRouting.fields.assignee),
  audience: Schema.optionalKey(ThreadInboxRouting.fields.audience),
  attentionKind: Schema.optionalKey(ThreadInboxRouting.fields.attentionKind),
  reason: Schema.optionalKey(InboxReason),
});
export type ThreadInboxRoutingPatch = typeof ThreadInboxRoutingPatch.Type;
export const ThreadDecisionAsk = Schema.Struct({
  founder: Founder,
  kind: Schema.Literals(["decision", "review", "approval"]),
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
});
export type ThreadDecisionAsk = typeof ThreadDecisionAsk.Type;
export const ThreadDecisionRequest = Schema.Struct({
  ...ThreadDecisionAsk.fields,
  requestedAt: IsoDateTime,
});
export type ThreadDecisionRequest = typeof ThreadDecisionRequest.Type;
export const ThreadInbox = Schema.Struct({
  ...ThreadInboxRouting.fields,
  reason: Schema.optionalKey(InboxReason),
  /** Open until the founder writes on the thread after `requestedAt`, or it is resolved or settled. */
  decisionRequest: Schema.optionalKey(ThreadDecisionRequest),
  /** Set only on projected shells: the thread waits on an approval or user input. Never stored. */
  pendingHumanRequest: Schema.optionalKey(Schema.Boolean),
  origin: Schema.NullOr(InboxActor),
  requestedBy: Schema.NullOr(InboxActor),
  actor: Schema.NullOr(InboxActor),
  executorEnvironmentId: Schema.NullOr(EnvironmentId),
});
export type ThreadInbox = typeof ThreadInbox.Type;
export const INBOX_CAPABILITY = "closura-founder-inbox-v2" as const;
export const InboxView = Schema.Literals(["kameron", "jeff", "shared", "agents", "all"]);
export type InboxView = typeof InboxView.Type;
/** An inbox a thread can be filed into: every view except All. */
export const InboxChoice = Schema.Literals(["kameron", "jeff", "shared", "agents"]);
export type InboxChoice = typeof InboxChoice.Type;

/** The routing that files a thread into one inbox, shared by the thread menu and agent launches. */
export function inboxRoutingFor(inbox: InboxChoice): ThreadInboxRouting {
  if (inbox === "shared")
    return { owner: null, assignee: null, audience: "shared", attentionKind: "FYI" };
  if (inbox === "agents")
    return { owner: null, assignee: null, audience: "agent-only", attentionKind: "background" };
  return {
    owner: inbox,
    assignee: { kind: "human", id: inbox },
    audience: inbox,
    attentionKind: "action",
  };
}

/**
 * Where an agent-launched top-level thread is filed: the chosen inbox, else Agents, so agent
 * work never lands in a founder's inbox by default. `inboxRouting` adjusts the chosen inbox.
 */
export const agentLaunchInboxRouting = (input: {
  readonly inbox?: InboxChoice | undefined;
  readonly inboxRouting?: ThreadInboxRoutingPatch | undefined;
}): ThreadInboxRoutingPatch =>
  input.inbox === undefined
    ? (input.inboxRouting ?? inboxRoutingFor("agents"))
    : { ...inboxRoutingFor(input.inbox), ...input.inboxRouting };

export const InboxChoiceParameter = InboxChoice.annotate({
  description:
    "Sidebar inbox for the new thread. Default 'agents': autonomous work reports one final result there. Pick 'kameron' or 'jeff' (your `inbox.owner` in t3_thread_read) or 'shared' only when they will converse in it, review, decide or approve, and set `inboxRouting.reason`.",
});
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
    ...(routing?.reason === undefined ? {} : { reason: routing.reason }),
    origin: actor,
    actor,
    requestedBy: input.requestedBy ?? input.parent?.requestedBy ?? actor,
    executorEnvironmentId: input.executorEnvironmentId ?? null,
  };
}

/** True when the thread can show in a founder's or the shared inbox, not only in Agents. */
const inboxReachesFounders = (inbox: ThreadInboxRouting) =>
  inbox.audience !== "agent-only" || inbox.assignee?.kind === "human";

/**
 * Preserve immutable origin/requester/executor when routing an existing thread. Agents must state
 * a reason (see `agentInboxRoutingError`), so a reason-less route to a founder came from a person.
 */
export const routeThreadInbox = (
  inbox: ThreadInbox,
  routing: ThreadInboxRoutingPatch,
): ThreadInbox => {
  const { reason, ...fields } = routing;
  // A move ends any open ask: it would otherwise keep the thread in the asked founder's lane.
  const { decisionRequest: _ask, ...current } = inbox;
  const { reason: _previous, ...routed } = {
    ...current,
    ...fields,
    ...(fields.assignee?.kind === "human"
      ? {
          owner: fields.owner === undefined ? fields.assignee.id : fields.owner,
          audience: fields.audience ?? fields.assignee.id,
          attentionKind:
            fields.attentionKind ??
            (inbox.attentionKind === "background" ? "action" : inbox.attentionKind),
        }
      : {}),
  };
  const kept = reason ?? (inboxReachesFounders(routed) ? "conversation" : undefined);
  return kept === undefined ? routed : { ...routed, reason: kept };
};

/**
 * Agent routing that would reach a founder's or the shared inbox must carry a reason. Returns the
 * rejection for the agent, or null. People route from the UI without this check.
 */
export function agentInboxRoutingError(
  result: ThreadInboxRouting,
  routing: ThreadInboxRoutingPatch | undefined,
): string | null {
  if (routing?.reason !== undefined || !inboxReachesFounders(result)) return null;
  return "Agent work files into the Agents inbox and reports one final result there. Put a thread in a founder's or the shared inbox only when they will converse in it, review, decide or approve: pass inboxRouting.reason ('conversation', 'review', 'decision', 'approval' or 'fyi'). To ask a founder something on a thread, use t3_thread_update action:'request_decision' and also write the question in the thread, where they read it. If the answer reaches you another way, such as a relayed approval, call action:'resolve_decision'.";
}

/** The rejection for an agent launch filed by `agentLaunchInboxRouting`, or null. */
export const agentLaunchInboxError = (input: Parameters<typeof agentLaunchInboxRouting>[0]) => {
  const routing = agentLaunchInboxRouting(input);
  return agentInboxRoutingError(
    makeThreadInbox({ actor: { kind: "agent", id: "agent" }, routing }),
    routing,
  );
};

/**
 * The inbox clients read. A decision request closes once a person writes on the thread after it
 * was asked; a pending approval or user-input request surfaces to the owner.
 */
export function projectThreadInbox(
  inbox: ThreadInbox,
  state: { readonly pendingHumanRequest: boolean; readonly latestHumanMessageAt: string | null },
): ThreadInbox {
  const { decisionRequest, pendingHumanRequest: _stored, ...rest } = inbox;
  const open =
    decisionRequest !== undefined &&
    (state.latestHumanMessageAt === null ||
      Date.parse(state.latestHumanMessageAt) <= Date.parse(decisionRequest.requestedAt));
  return {
    ...rest,
    ...(open ? { decisionRequest } : {}),
    ...(state.pendingHumanRequest ? { pendingHumanRequest: true } : {}),
  };
}

/**
 * A founder's lane holds only threads waiting on them: an open decision request for them, a
 * pending runtime request on a thread they own, or a thread they own that a person filed or an
 * agent filed with a reason. Other agent work stays in Agents.
 */
export function founderInboxLane(inbox: ThreadInbox | null | undefined, founder: Founder) {
  if (!inbox) return "unknown";
  if (inbox.decisionRequest?.founder === founder) return "action";
  if (inbox.pendingHumanRequest === true && inbox.owner === founder) return "action";
  const assigned = inbox.assignee?.kind === "human" ? inbox.assignee.id : inbox.owner;
  if (inbox.audience === "agent-only" && inbox.assignee?.kind !== "human") return "hidden";
  if (assigned !== founder) return "hidden";
  if (inbox.origin?.kind === "agent" && inbox.reason === undefined) return "hidden";
  return inbox.reason === "fyi" && inbox.attentionKind === "action" ? "FYI" : inbox.attentionKind;
}

/** The chosen view, else the chosen founder's, else All so unclassified history stays visible. */
export const effectiveInboxView = (settings: {
  readonly founderInboxView?: InboxView | undefined;
  readonly founderInboxOwner?: Founder | undefined;
}): InboxView => settings.founderInboxView ?? settings.founderInboxOwner ?? "all";

/** New work is attributed only to a chosen founder; otherwise it stays unclassified (All). */
export const inboxOriginFor = (settings: {
  readonly founderInboxOwner?: Founder | undefined;
}): InboxActor | undefined =>
  settings.founderInboxOwner === undefined
    ? undefined
    : { kind: "human", id: settings.founderInboxOwner };

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
