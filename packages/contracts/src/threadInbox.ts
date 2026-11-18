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
    "Sidebar inbox for the new thread. Default 'agents'. Pick 'kameron' or 'jeff' only when that founder asked for it or must act on it (your thread's `inbox.owner` in t3_thread_read); 'shared' for both. `inboxRouting` adjusts fields of the chosen inbox.",
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

/**
 * The inboxes the sidebar lists: the chosen ones, else the chosen founder's plus Agents, else
 * every inbox so unclassified history stays visible.
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
      : [settings.founderInboxOwner, "agents"];

/** Choosing every inbox means All, which also keeps unclassified history. */
const isAllInboxes = (filter: ReadonlyArray<InboxChoice>) =>
  InboxChoice.literals.every((choice) => filter.includes(choice));

/**
 * The one inbox a thread is filtered under, so unchecking an inbox hides all of its threads:
 * Shared, else the founder it is filed to, else Agents. Null is unclassified history.
 */
export function primaryInbox(inbox: ThreadInbox | null | undefined): InboxChoice | null {
  if (matchesInboxView(inbox, "shared")) return "shared";
  for (const founder of Founder.literals) if (matchesInboxView(inbox, founder)) return founder;
  return matchesInboxView(inbox, "agents") ? "agents" : null;
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

/**
 * Who a thread came from, before its machine's owner is applied: `"machine"` stands for that
 * owner, which clients look up. `byAgent` marks an agent's work for that founder.
 */
export interface ThreadSender {
  readonly founder: Founder | "machine" | null;
  readonly byAgent: boolean;
}

export interface ThreadSenderInput {
  readonly key: string;
  /** The parent's key; a parent always shares the thread's environment. */
  readonly parentKey: string | null;
  readonly inbox?: ThreadInbox | null | undefined;
  readonly createdBy?: string | undefined;
}

const humanFounder = (actor: InboxActor | null | undefined): Founder | null =>
  actor?.kind === "human" ? actor.id : null;

/**
 * Every thread's sender, keyed by `key`. A human origin or requester is that founder; agent work
 * takes its owner, else its parent's founder; only history without inbox fields falls back to the
 * machine's owner. Servers count older settled threads by sender and clients label rows by it, so
 * the two agree.
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
    const parent =
      thread.parentKey === null || resolving.has(thread.parentKey)
        ? undefined
        : byKey.get(thread.parentKey);
    const human = humanFounder(inbox?.origin);
    const founder =
      human ??
      humanFounder(inbox?.requestedBy) ??
      (inbox?.origin?.kind === "agent"
        ? (inbox.owner ?? (parent ? resolve(parent).founder : null))
        : null) ??
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
