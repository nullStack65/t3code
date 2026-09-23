/**
 * Route, identity, and experiment view over the usage attribution projection.
 *
 * `buildUsageAttribution` answers "how much usage did each native session and
 * pull request get". This companion module answers the canary's question: "which
 * models, sessions, and assignments contributed to this T3 thread, and what was
 * requested versus observed". It composes the base projection rather than
 * duplicating it, and it adds only what the base levels cannot express:
 *
 * - readable manager/agent identity, kept explicitly distinct from the native
 *   session id (a label is never a substitute for a real session id);
 * - requested provider/model/effort from route metadata versus the observed
 *   model from measured usage (the two are never copied into each other);
 * - pre-execution task stratum, experiment/cohort, route event kind, and the
 *   fallback/escalation reason;
 * - parent/child session lineage so a child session is never flattened into
 *   its parent's usage.
 *
 * It is pure. It never reads the clock, the filesystem, or the database, and it
 * never sees a prompt, response, or tool body.
 *
 * @module usageRouteAttribution
 */
import type { UsageProviderKind } from "@t3tools/contracts";

import {
  buildUsageAttribution,
  type AttributionIdentityQuality,
  type AttributionPullRequestLink,
  type AttributionQuality,
  type AttributionSessionReport,
  type AttributionSource,
  type AttributionThreadBinding,
  type AttributionTotals,
  type AttributionUsageRecord,
  type UsageAttribution,
} from "./usageAttribution.ts";
import type { ExtractedSessionHistory } from "./usageAttributionSources.ts";
import {
  hasRouteSelectionValue,
  type RouteEventKind,
  type RouteEventMetadata,
  type RouteSelectionMetadata,
  type RouteSelectionQuality,
  type TaskStratum,
} from "./routeMetadata.ts";
import { addTotals, EMPTY_TOTALS } from "./usageTranscripts.ts";

export const USAGE_ROUTE_ATTRIBUTION_VERSION = 1 as const;

export interface UsageRouteAttributionInput {
  /** Read cutoff; associations are as of this instant. */
  readonly cutoffMs: number;
  readonly records: readonly AttributionUsageRecord[];
  /** Bindings must already include durable session-history bindings. */
  readonly bindings: readonly AttributionThreadBinding[];
  readonly links: readonly AttributionPullRequestLink[];
  readonly sources: readonly AttributionSource[];
  /** Append-only native-session identity history, including unmeasured providers. */
  readonly history: readonly ExtractedSessionHistory[];
  /** Pre-execution route and experiment metadata. */
  readonly routeEvents: readonly RouteEventMetadata[];
}

/**
 * The base session report's measurement and identity axes, carried on the route
 * session so the follow-on view cannot silently drop them and present a partial
 * or invalid measurement — or a legacy identity-erased row — as exact.
 */
export interface SessionRouteQuality {
  /** Numeric completeness: `measured | partial | invalid | missing | unavailable`. */
  readonly measurement: AttributionQuality;
  /** Native-identity validity, independent of the measurement. */
  readonly identity: AttributionIdentityQuality;
  /** Prompt-level identity quality. */
  readonly prompt: AttributionQuality;
  /** Request-level identity quality; a legacy identity-erased row is `unavailable`. */
  readonly request: AttributionQuality;
  /** `uncertain` when a contributing record had no scan/delivery identity. */
  readonly recordIdentity: "exact" | "uncertain";
  /** `true` when two versions of one identity disagreed (including cost-only). */
  readonly conflict: boolean;
}

export interface SessionRouteReport {
  /** `null` when T3 has no scanned usage source for the provider (OpenCode). */
  readonly provider: UsageProviderKind | null;
  readonly sessionId: string;
  readonly threadId: string | null;
  readonly models: readonly string[];
  /** `null` means unknown, never zero. Absence is not a measured zero. */
  readonly usage: AttributionTotals | null;
  /**
   * Measurement and identity quality from the base projection, or `null` when no
   * usage was measured for this identity (so there is no measurement to qualify).
   */
  readonly quality: SessionRouteQuality | null;
  readonly parentSessionId: string | null;
  readonly requested: RouteSelectionMetadata | null;
  readonly requestedQuality: RouteSelectionQuality;
  readonly actualProvider: string | null;
  readonly actualModel: string | null;
  readonly actualEffort: string | null;
  /** No scanned source exposes reasoning effort, so this is always `unsupported`. */
  readonly actualEffortQuality: RouteSelectionQuality;
  readonly routeEventKind: RouteEventKind | null;
  readonly taskStratum: TaskStratum;
  readonly experimentId: string | null;
  readonly managerId: string | null;
  readonly agentId: string | null;
  readonly escalationReason: string | null;
}

export interface ThreadRouteReport {
  readonly threadId: string;
  readonly sessionLabels: readonly string[];
  readonly models: readonly string[];
  /** Additive over this thread's sessions; misses nothing, double counts nothing. */
  readonly usage: AttributionTotals;
  readonly pullRequestKeys: readonly string[];
  readonly experimentIds: readonly string[];
  readonly managerIds: readonly string[];
  readonly agentIds: readonly string[];
  readonly routeEventKinds: readonly RouteEventKind[];
}

export interface RouteIdentityDiagnostics {
  readonly managerIds: readonly string[];
  readonly agentIds: readonly string[];
  readonly sessionsWithRouteMetadata: number;
  readonly sessionsWithParent: number;
}

export interface UsageRouteAttribution {
  readonly contractVersion: typeof USAGE_ROUTE_ATTRIBUTION_VERSION;
  readonly generatedAtMs: number;
  /** The unchanged base projection, so callers keep the proven levels. */
  readonly base: UsageAttribution;
  readonly sessions: readonly SessionRouteReport[];
  readonly threads: readonly ThreadRouteReport[];
  readonly routeEvents: readonly RouteEventMetadata[];
  readonly identity: RouteIdentityDiagnostics;
  readonly limitations: readonly string[];
}

const ZERO: AttributionTotals = {
  tokens: EMPTY_TOTALS,
  totalTokens: 0,
  costUsd: 0,
  records: 0,
};

function addTotalsOf(left: AttributionTotals, right: AttributionTotals): AttributionTotals {
  return {
    tokens: addTotals(left.tokens, right.tokens),
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd: left.costUsd + right.costUsd,
    records: left.records + right.records,
  };
}

function sessionKey(provider: UsageProviderKind, sessionId: string): string {
  return `${provider}\u0000${sessionId}`;
}

function sessionLabel(provider: UsageProviderKind | null, sessionId: string): string {
  return `${provider ?? "unmeasured"}:${sessionId}`;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function compareEvents(left: RouteEventMetadata, right: RouteEventMetadata): number {
  if (left.recordedAt !== right.recordedAt) return left.recordedAt < right.recordedAt ? -1 : 1;
  return left.eventId.localeCompare(right.eventId);
}

/**
 * Picks the route event that best describes one session: a declared event for
 * the exact session first, then a declared event for its thread, then the
 * automatic request record. A declared event always outranks a request record
 * because it carries the classification the canary cares about.
 */
function selectRouteEvent(
  sessionId: string,
  threadId: string | null,
  declaredByThread: ReadonlyMap<string, readonly RouteEventMetadata[]>,
  requestsByThread: ReadonlyMap<string, readonly RouteEventMetadata[]>,
): RouteEventMetadata | null {
  const consider = (
    events: readonly RouteEventMetadata[] | undefined,
  ): RouteEventMetadata | null => {
    if (events === undefined || events.length === 0) return null;
    const exact = events.find((event) => event.nativeSessionId === sessionId);
    return exact ?? events[0]!;
  };
  if (threadId === null) return null;
  return (
    consider(declaredByThread.get(threadId)) ?? consider(requestsByThread.get(threadId)) ?? null
  );
}

export function buildUsageRouteAttribution(
  input: UsageRouteAttributionInput,
): UsageRouteAttribution {
  const base = buildUsageAttribution({
    generatedAtMs: input.cutoffMs,
    records: input.records,
    bindings: input.bindings,
    links: input.links,
    sources: input.sources,
  });

  const baseByKey = new Map<string, AttributionSessionReport>();
  for (const session of base.sessions) {
    baseByKey.set(sessionKey(session.provider, session.sessionId), session);
  }
  // Thread(s) a session is bound to, for sessions that have no history row.
  const threadsByKey = new Map<string, string[]>();
  for (const binding of input.bindings) {
    const key = sessionKey(binding.provider, binding.nativeSessionId);
    const threads = threadsByKey.get(key) ?? [];
    if (!threads.includes(binding.threadId)) threads.push(binding.threadId);
    threadsByKey.set(key, threads);
  }

  const declaredByThread = new Map<string, RouteEventMetadata[]>();
  const requestsByThread = new Map<string, RouteEventMetadata[]>();
  for (const event of input.routeEvents) {
    const target = event.kind === null ? requestsByThread : declaredByThread;
    const list = target.get(event.threadId) ?? [];
    list.push(event);
    target.set(event.threadId, list);
  }
  for (const list of [...declaredByThread.values(), ...requestsByThread.values()]) {
    list.sort(compareEvents);
  }

  const sessionReports: SessionRouteReport[] = [];
  const consumedBaseKeys = new Set<string>();

  const reportForBase = (
    session: AttributionSessionReport,
    threadId: string | null,
    parentSessionId: string | null,
  ): SessionRouteReport => {
    const selected = selectRouteEvent(
      session.sessionId,
      threadId,
      declaredByThread,
      requestsByThread,
    );
    const requested = selected?.requested ?? null;
    const actualModel = session.models.length === 1 ? (session.models[0] ?? null) : null;
    return {
      provider: session.provider,
      sessionId: session.sessionId,
      threadId,
      models: session.models,
      usage: session.totals,
      quality: {
        measurement: session.measurementQuality,
        identity: session.identityQuality,
        prompt: session.promptQuality,
        request: session.requestQuality,
        recordIdentity: session.recordIdentity,
        conflict: session.conflict,
      },
      parentSessionId,
      requested,
      requestedQuality: requested === null ? "unknown" : "declared",
      actualProvider: session.provider,
      actualModel,
      actualEffort: null,
      actualEffortQuality: "unsupported",
      routeEventKind: selected?.kind ?? null,
      taskStratum: selected?.taskStratum ?? "unknown",
      experimentId: selected?.experimentId ?? null,
      managerId: selected?.managerId ?? null,
      agentId: selected?.agentId ?? null,
      escalationReason: selected?.reason ?? null,
    };
  };

  // 1. Every durable identity, including providers T3 cannot measure. An
  //    unmeasured identity reports a null total, never a zero.
  for (const entry of input.history) {
    const key =
      entry.usageProvider === null ? null : sessionKey(entry.usageProvider, entry.nativeSessionId);
    const baseSession = key === null ? undefined : baseByKey.get(key);
    if (key !== null) consumedBaseKeys.add(key);
    if (baseSession !== undefined) {
      sessionReports.push(reportForBase(baseSession, entry.threadId, entry.parentNativeSessionId));
      continue;
    }
    const selected = selectRouteEvent(
      entry.nativeSessionId,
      entry.threadId,
      declaredByThread,
      requestsByThread,
    );
    const requested = selected?.requested ?? null;
    sessionReports.push({
      provider: entry.usageProvider,
      sessionId: entry.nativeSessionId,
      threadId: entry.threadId,
      models: [],
      usage: null,
      quality: null,
      parentSessionId: entry.parentNativeSessionId,
      requested,
      requestedQuality: requested === null ? "unknown" : "declared",
      actualProvider: null,
      actualModel: null,
      actualEffort: null,
      actualEffortQuality: "unsupported",
      routeEventKind: selected?.kind ?? null,
      taskStratum: selected?.taskStratum ?? "unknown",
      experimentId: selected?.experimentId ?? null,
      managerId: selected?.managerId ?? null,
      agentId: selected?.agentId ?? null,
      escalationReason: selected?.reason ?? null,
    });
  }

  // 2. Sessions the base projection knows but history did not name (for
  //    example a caller that supplied only cursor bindings).
  for (const session of base.sessions) {
    const key = sessionKey(session.provider, session.sessionId);
    if (consumedBaseKeys.has(key)) continue;
    const threads = threadsByKey.get(key) ?? [];
    const threadId = threads.length === 1 ? (threads[0] ?? null) : null;
    sessionReports.push(reportForBase(session, threadId, null));
  }

  sessionReports.sort((left, right) =>
    sessionLabel(left.provider, left.sessionId).localeCompare(
      sessionLabel(right.provider, right.sessionId),
    ),
  );

  // 3. Per-thread rollup. Usage is summed once per session, so association with
  //    multiple PRs can never duplicate a session's tokens.
  const prKeysByThread = new Map<string, Set<string>>();
  for (const pr of base.pullRequests) {
    for (const threadId of pr.threadIds) {
      const set = prKeysByThread.get(threadId) ?? new Set<string>();
      set.add(pr.key);
      prKeysByThread.set(threadId, set);
    }
  }
  const threadIds = new Set<string>();
  for (const session of sessionReports)
    if (session.threadId !== null) threadIds.add(session.threadId);
  for (const threadId of declaredByThread.keys()) threadIds.add(threadId);
  for (const threadId of requestsByThread.keys()) threadIds.add(threadId);

  const threads: ThreadRouteReport[] = [...threadIds]
    .toSorted((left, right) => left.localeCompare(right))
    .map((threadId): ThreadRouteReport => {
      const sessions = sessionReports.filter((session) => session.threadId === threadId);
      let usage = ZERO;
      for (const session of sessions) {
        if (session.usage !== null) usage = addTotalsOf(usage, session.usage);
      }
      const events = [
        ...(declaredByThread.get(threadId) ?? []),
        ...(requestsByThread.get(threadId) ?? []),
      ];
      return {
        threadId,
        sessionLabels: sessions.map((session) => sessionLabel(session.provider, session.sessionId)),
        models: sortedUnique(sessions.flatMap((session) => session.models)),
        usage,
        pullRequestKeys: [...(prKeysByThread.get(threadId) ?? [])].toSorted((left, right) =>
          left.localeCompare(right),
        ),
        experimentIds: sortedUnique(
          events.map((event) => event.experimentId).filter((id): id is string => id !== null),
        ),
        managerIds: sortedUnique(
          events.map((event) => event.managerId).filter((id): id is string => id !== null),
        ),
        agentIds: sortedUnique(
          events.map((event) => event.agentId).filter((id): id is string => id !== null),
        ),
        routeEventKinds: [
          ...new Set(
            events.map((event) => event.kind).filter((k): k is RouteEventKind => k !== null),
          ),
        ].toSorted((left, right) => left.localeCompare(right)),
      };
    });

  const identity: RouteIdentityDiagnostics = {
    managerIds: sortedUnique(
      input.routeEvents.map((event) => event.managerId).filter((id): id is string => id !== null),
    ),
    agentIds: sortedUnique(
      input.routeEvents.map((event) => event.agentId).filter((id): id is string => id !== null),
    ),
    sessionsWithRouteMetadata: sessionReports.filter(
      (session) => session.routeEventKind !== null || hasRouteSelectionValue(session.requested),
    ).length,
    sessionsWithParent: sessionReports.filter((session) => session.parentSessionId !== null).length,
  };

  return {
    contractVersion: USAGE_ROUTE_ATTRIBUTION_VERSION,
    generatedAtMs: input.cutoffMs,
    base,
    sessions: sessionReports,
    threads,
    routeEvents: input.routeEvents.slice().sort(compareEvents),
    identity,
    limitations: limitationsFor(input, sessionReports),
  };
}

function limitationsFor(
  input: UsageRouteAttributionInput,
  sessions: readonly SessionRouteReport[],
): readonly string[] {
  const limitations: string[] = [
    "Observed reasoning effort is not exposed by any scanned source, so `actualEffort` is always null with quality `unsupported`; it is never copied from the requested effort.",
    "A readable manager/agent id is a label for a route decision. It never replaces the native provider session id, and it is not used to join usage.",
    "Requested values are pre-execution declarations. An observed value is only reported from a measured usage record.",
  ];
  if (sessions.some((session) => session.provider === null)) {
    limitations.push(
      "Some durable identities belong to a provider T3 does not scan for usage (for example OpenCode child sessions). Their usage is unknown, not zero, and is preserved as its own identity rather than flattened into the parent.",
    );
  }
  if (sessions.some((session) => session.usage === null)) {
    limitations.push(
      "Some sessions have no measured usage. A null total is unknown, not a zero-cost success.",
    );
  }
  if (input.routeEvents.length === 0) {
    limitations.push(
      "No route metadata was supplied, so requested provider/model/effort and the experiment/cohort are unknown for every session.",
    );
  }
  return limitations;
}
