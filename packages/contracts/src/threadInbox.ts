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
/**
 * One founder's answer on a call both founders make. `signed` is set once they
 * reply; an open ask lists both with none signed.
 */
export const FounderSignOff = Schema.Struct({
  founder: Founder,
  signed: Schema.Boolean,
});
export type FounderSignOff = typeof FounderSignOff.Type;

const jointSignOffEntries = Schema.Array(FounderSignOff).check(
  Schema.isMinLength(2),
  Schema.isMaxLength(2),
  Schema.makeFilter((entries) => {
    const founders = new Set(entries.map((entry) => entry.founder));
    return founders.size === Founder.literals.length &&
      Founder.literals.every((founder) => founders.has(founder))
      ? true
      : "A joint sign-off lists Kameron and Jeff once each.";
  }),
);

export const ThreadDecisionAsk = Schema.Struct({
  founder: Founder,
  kind: Schema.Literals(["decision", "review", "approval"]),
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
  /**
   * Set only when both founders must answer. Absent, the ask is the one
   * `founder`'s alone. A stored ask from before this field decodes without it.
   */
  signOff: Schema.optional(
    jointSignOffEntries.annotate({
      description: "Both founders' answers, when the call needs each of them.",
    }),
  ),
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
  /**
   * Open until the asked founder writes after `requestedAt`. A joint sign-off stays open until
   * each founder has written. Resolving or settling the thread also closes it.
   */
  decisionRequest: Schema.optionalKey(ThreadDecisionRequest),
  /** Set only on projected shells: the thread waits on an approval or user input. Never stored. */
  pendingHumanRequest: Schema.optionalKey(Schema.Boolean),
  origin: Schema.NullOr(InboxActor),
  requestedBy: Schema.NullOr(InboxActor),
  actor: Schema.NullOr(InboxActor),
  executorEnvironmentId: Schema.NullOr(EnvironmentId),
});
export type ThreadInbox = typeof ThreadInbox.Type;
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
  // An agent's child work reports in Agents, so it never inherits a founder audience from its
  // parent: with no reason, that would be indistinguishable from a lane filed before reasons.
  const audience =
    routing?.audience ??
    target ??
    (actor?.kind === "agent" && input.parent ? "agent-only" : undefined) ??
    input.parent?.audience ??
    owner ??
    "agent-only";
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

/**
 * What a linked environment sends in `T3-Peer-Features` once its tools forward
 * `inboxRouting.reason`. Releases before it have no such field in their tool schema, so their
 * agents cannot give a reason at all.
 */
export const PEER_FEATURE_INBOX_REASON = "inbox-reason" as const;

/**
 * Files a reason-less route from an older linked environment as `fyi` instead of rejecting it:
 * that agent's tools cannot send a reason, so the rejection would be a dead end. `fyi` is what
 * lanes filed before reasons existed already show as (see `founderInboxLane`). Routes that
 * carry a reason, and routes that touch no inbox, are returned unchanged.
 */
export function withLegacyPeerInboxReason<
  T extends {
    readonly inbox?: InboxChoice | undefined;
    readonly inboxRouting?: ThreadInboxRoutingPatch | undefined;
  },
>(input: T, legacyPeer: boolean): T {
  if (!legacyPeer || input.inboxRouting?.reason !== undefined) return input;
  // Only a route the strict guard would reject: one that reaches a founder or the shared inbox.
  // A route that stays in Agents keeps no reason.
  if (agentLaunchInboxError(input) === null) return input;
  return { ...input, inboxRouting: { ...input.inboxRouting, reason: "fyi" } };
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
 * Both founders, in pill order, when `signOff` lists each of them once. Anything else is not a
 * joint call, including a duplicate of one founder.
 */
export function jointSignOff(
  signOff: ReadonlyArray<FounderSignOff> | null | undefined,
): ReadonlyArray<FounderSignOff> | null {
  if (signOff == null || signOff.length !== Founder.literals.length) return null;
  const byFounder = new Map(signOff.map((entry) => [entry.founder, entry]));
  if (byFounder.size !== Founder.literals.length) return null;
  const ordered: FounderSignOff[] = [];
  for (const founder of Founder.literals) {
    const entry = byFounder.get(founder);
    if (entry === undefined) return null;
    ordered.push(entry);
  }
  return ordered;
}

type ReplyClock = string | { readonly epochMilliseconds: number };

const replyMillis = (value: ReplyClock): number =>
  typeof value === "string" ? Date.parse(value) : value.epochMilliseconds;

/**
 * A founder's own reply signs only that founder on a joint ask. The ask stays until both have
 * signed. A message that signs nobody returns the same inbox, so a writer can skip the rewrite.
 */
export function inboxAfterFounderReply<Inbox extends ThreadInbox | undefined>(
  inbox: Inbox,
  message: {
    readonly role: string;
    readonly createdBy?: string | undefined;
    readonly idleCompaction?: unknown;
    readonly sentBy?: { readonly founder: Founder | null } | undefined;
    readonly updatedAt: ReplyClock;
  },
): Inbox {
  if (inbox === undefined) return inbox;
  const request = inbox.decisionRequest;
  const ordered = jointSignOff(request?.signOff);
  if (request === undefined || ordered === null) return inbox;
  const founder = message.sentBy?.founder;
  if (
    message.role !== "user" ||
    message.createdBy !== "user" ||
    message.idleCompaction != null ||
    (founder !== "kameron" && founder !== "jeff") ||
    replyMillis(message.updatedAt) <= replyMillis(request.requestedAt)
  ) {
    return inbox;
  }
  const entry = ordered.find((item) => item.founder === founder);
  if (entry === undefined || entry.signed) return inbox;
  const next = ordered.map((item) => (item.founder === founder ? { ...item, signed: true } : item));
  if (next.every((item) => item.signed)) {
    const { decisionRequest: _closed, ...rest } = inbox;
    return rest as Inbox;
  }
  return { ...inbox, decisionRequest: { ...request, signOff: next } };
}

/**
 * The inbox clients read. A decision request closes once a person writes on the thread after it
 * was asked. A joint sign-off stays open until each founder has signed. A pending approval or
 * user-input request surfaces to the owner. A standing desk reads as FYI unless one is open.
 */
export function projectThreadInbox(
  inbox: ThreadInbox,
  state: {
    readonly pendingHumanRequest: boolean;
    readonly latestHumanMessageAt: string | null;
    readonly standing?: boolean;
  },
): ThreadInbox {
  const { decisionRequest, pendingHumanRequest: _stored, ...rest } = inbox;
  const joint = jointSignOff(decisionRequest?.signOff);
  const open =
    decisionRequest !== undefined &&
    (joint !== null
      ? joint.some((entry) => !entry.signed)
      : state.latestHumanMessageAt === null ||
        Date.parse(state.latestHumanMessageAt) <= Date.parse(decisionRequest.requestedAt));
  // A standing desk (CoS, CTO) is somewhere to talk, not an ask: FYI until something is asked.
  const quietDesk =
    state.standing === true &&
    rest.attentionKind === "action" &&
    !open &&
    !state.pendingHumanRequest;
  return {
    ...rest,
    ...(quietDesk ? { attentionKind: "FYI" as const } : {}),
    ...(open ? { decisionRequest } : {}),
    ...(state.pendingHumanRequest ? { pendingHumanRequest: true } : {}),
  };
}

/**
 * A founder's lane holds only threads waiting on them: an open decision request for them, a
 * pending runtime request on a thread they own, or a thread they own that a person filed or an
 * agent filed with a reason, or an agent lane routed to them before reasons existed (FYI).
 * Other agent work stays in Agents.
 */
export function founderInboxLane(inbox: ThreadInbox | null | undefined, founder: Founder) {
  if (!inbox) return "unknown";
  const joint = jointSignOff(inbox.decisionRequest?.signOff);
  if (joint !== null) {
    const mine = joint.find((entry) => entry.founder === founder);
    // A founder who has already signed is no longer waiting, even if the ask names them.
    if (mine !== undefined && !mine.signed) return "action";
  } else if (inbox.decisionRequest?.founder === founder) {
    return "action";
  }
  if (inbox.pendingHumanRequest === true && inbox.owner === founder) return "action";
  const assigned = inbox.assignee?.kind === "human" ? inbox.assignee.id : inbox.owner;
  if (inbox.audience === "agent-only" && inbox.assignee?.kind !== "human") return "hidden";
  if (assigned !== founder) return "hidden";
  if (inbox.origin?.kind === "agent" && inbox.reason === undefined)
    // Lanes filed before `reason` existed carry none. Routed to this founder they stay visible as
    // FYI; agent work that merely names them as owner (audience elsewhere) stays in Agents.
    return inbox.audience === founder ? "FYI" : "hidden";
  return inbox.reason === "fyi" && inbox.attentionKind === "action" ? "FYI" : inbox.attentionKind;
}

/**
 * The inboxes the sidebar lists: the chosen ones, else the chosen founder's plus Agents and
 * Shared, else every inbox so unclassified history stays visible. Shared is a default so both
 * founders see shared bots without opening the filter.
 */
export const effectiveInboxFilter = (settings: {
  readonly founderInboxFilter?: ReadonlyArray<InboxChoice> | undefined;
  readonly founderInboxOwner?: Founder | undefined;
}): ReadonlyArray<InboxChoice> =>
  // An empty choice, from another client or a hand edit, would blank the list; treat it as unset.
  settings.founderInboxFilter !== undefined && settings.founderInboxFilter.length > 0
    ? settings.founderInboxFilter
    : settings.founderInboxOwner === undefined
      ? InboxChoice.literals
      : [settings.founderInboxOwner, "agents", "shared"];

/** Choosing every inbox means All, which also keeps unclassified history. */
const isAllInboxes = (filter: ReadonlyArray<InboxChoice>) =>
  InboxChoice.literals.every((choice) => filter.includes(choice));

/**
 * A thread waiting on a founder whose inbox is shown stays in the active list while it works,
 * so the collapsed Working shelf cannot hide it. Agents, Shared and FYI work are unaffected.
 */
export function staysActiveWhileWorking(
  inbox: ThreadInbox | null | undefined,
  filter: ReadonlyArray<InboxChoice>,
) {
  return Founder.literals.some(
    (founder) => filter.includes(founder) && founderInboxLane(inbox, founder) === "action",
  );
}

/**
 * The one inbox a thread is filtered under, so unchecking an inbox hides all of its threads:
 * Shared, else the founder it is filed to, else Agents. Null is unclassified history.
 */
export function primaryInbox(inbox: ThreadInbox | null | undefined): InboxChoice | null {
  if (matchesInboxView(inbox, "shared")) return "shared";
  for (const founder of Founder.literals) if (matchesInboxView(inbox, founder)) return founder;
  // Anything else classified, such as background work filed to a founder, reports in Agents.
  return inbox ? "agents" : null;
}

/** `matchesInboxFilter` for a thread already reduced to its `primaryInbox`. */
export const matchesPrimaryInbox = (
  primary: InboxChoice | null,
  filter: ReadonlyArray<InboxChoice>,
) => isAllInboxes(filter) || (primary !== null && filter.includes(primary));

export const matchesInboxFilter = (
  inbox: ThreadInbox | null | undefined,
  filter: ReadonlyArray<InboxChoice>,
) => matchesPrimaryInbox(primaryInbox(inbox), filter);

/** New work is attributed only to a chosen founder; otherwise it stays unclassified (All). */
export const inboxOriginFor = (settings: {
  readonly founderInboxOwner?: Founder | undefined;
}): InboxActor | undefined =>
  settings.founderInboxOwner === undefined
    ? undefined
    : { kind: "human", id: settings.founderInboxOwner };

/**
 * Who a person's new thread is filed under. A session assigned to a founder files as that founder
 * whatever the client claims. An unassigned session keeps the client's choice and is never filed
 * under a guessed founder.
 */
export function creatorInboxOrigin(
  claimed: InboxActor | undefined,
  sender: { readonly founder: Founder | null; readonly deviceType: string },
): InboxActor | undefined {
  return sender.founder === null || sender.deviceType === "bot"
    ? claimed
    : { kind: "human", id: sender.founder };
}

/** Commands the server records a founder for: what they say, answer, or start. */
const FOUNDER_ATTRIBUTED_COMMANDS: ReadonlySet<string> = new Set([
  "message.dispatch",
  "queued-run.edit",
  "runtime-request.respond",
  "thread.create",
]);

/**
 * Whether `requireFounderIdentity` refuses this command: a person's session that no pairing code
 * or approved device enrolled as a founder may not send, answer or start work. Bots act as
 * themselves, and other commands are unaffected.
 */
export function refusesUnenrolledSender(
  requireFounderIdentity: boolean,
  commandType: string,
  sender: { readonly founder: Founder | null; readonly deviceType: string },
): boolean {
  return (
    requireFounderIdentity &&
    FOUNDER_ATTRIBUTED_COMMANDS.has(commandType) &&
    sender.deviceType !== "bot" &&
    sender.founder === null
  );
}

/** All deliberately includes every thread, including unclassified history. */
export function matchesInboxView(inbox: ThreadInbox | null | undefined, view: InboxView) {
  if (view === "all") return true;
  if (view === "agents")
    return (
      inbox?.origin?.kind === "agent" ||
      inbox?.assignee?.kind === "agent" ||
      inbox?.audience === "agent-only" ||
      (inbox != null && primaryInbox(inbox) === "agents")
    );
  if (view === "shared") return inbox?.audience === "shared";
  const lane = founderInboxLane(inbox, view);
  return lane === "action" || lane === "FYI";
}

/**
 * A sender's founder before its machine's owner is applied: `"machine"` stands for that owner,
 * which clients look up.
 */
export const SenderFounder = Schema.NullOr(Schema.Union([Founder, Schema.Literal("machine")]));
export type SenderFounder = typeof SenderFounder.Type;

/** Who a thread came from. `byAgent` marks an agent's work for that founder. */
export interface ThreadSender {
  readonly founder: SenderFounder;
  readonly byAgent: boolean;
}

export interface ThreadSenderInput {
  readonly key: string;
  /** The parent's key; a parent always shares the thread's environment. */
  readonly parentKey: string | null;
  readonly inbox?: ThreadInbox | null | undefined;
  readonly createdBy?: string | undefined;
  /** The founder the server resolved from the parent chain; used instead of walking parents. */
  readonly parentFounder?: SenderFounder | undefined;
}

const humanFounder = (actor: InboxActor | null | undefined): Founder | null =>
  actor?.kind === "human" ? actor.id : null;

/**
 * Whether a thread's sender comes from its parent: agent work with no owner or human requester.
 * The server's parent-chain read mirrors this in SQL.
 */
export const senderNeedsParent = (inbox: ThreadInbox | null | undefined): boolean =>
  inbox?.origin?.kind === "agent" && inbox.owner === null && inbox.requestedBy?.kind !== "human";

/**
 * Every thread's sender, keyed by `key`. A human origin or requester is that founder; agent work
 * takes its owner, else its parent's founder; only history without inbox fields falls back to the
 * machine's owner. Servers stamp `parentFounder` on the threads they send and count by it, so a
 * sender never depends on which parents a client holds; parents are walked only without it.
 */
export function resolveThreadSenders(
  threads: ReadonlyArray<ThreadSenderInput>,
): ReadonlyMap<string, ThreadSender> {
  const byKey = new Map(threads.map((thread) => [thread.key, thread]));
  const resolved = new Map<string, ThreadSender>();
  const resolving = new Set<string>();
  const resolve = (thread: ThreadSenderInput): ThreadSender => {
    const known = resolved.get(thread.key);
    if (known !== undefined) return known;
    // A lineage cycle resolves the repeated thread without its parent.
    resolving.add(thread.key);
    const inbox = thread.inbox;
    const fromParent = (): SenderFounder => {
      if (thread.parentFounder !== undefined) return thread.parentFounder;
      const parent =
        thread.parentKey === null || resolving.has(thread.parentKey)
          ? undefined
          : byKey.get(thread.parentKey);
      return parent ? resolve(parent).founder : null;
    };
    const human = humanFounder(inbox?.origin);
    const founder =
      human ??
      humanFounder(inbox?.requestedBy) ??
      (inbox?.origin?.kind === "agent" ? (inbox.owner ?? fromParent()) : null) ??
      // Only history from before inbox routing falls back to the machine: a shared machine
      // runs both founders' agents, so crediting routed work to its owner would be a guess.
      (inbox ? null : "machine");
    const sender: ThreadSender = {
      founder,
      byAgent: human === null && (inbox?.origin?.kind === "agent" || thread.createdBy === "agent"),
    };
    resolving.delete(thread.key);
    resolved.set(thread.key, sender);
    return sender;
  };
  for (const thread of byKey.values()) resolve(thread);
  return resolved;
}
