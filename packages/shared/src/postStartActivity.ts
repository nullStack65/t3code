/**
 * Post-start activity visibility.
 *
 * A running turn is not proof of progress. Providers can go quiet while the
 * turn is still live, and the existing status surface (a pulsing "Working"
 * pill plus wall-clock turn duration) cannot tell recent progress from
 * silence, a known long-running tool, or a connection we can no longer
 * observe. This module derives that distinction from the events the server
 * already persists, with deterministic event semantics and no model
 * interpretation.
 *
 * Sources of truth (no new state is produced here):
 * - `OrchestrationThreadActivity` rows: provider/tool/task lifecycle with a
 *   `turnId`, a monotonically ordered `sequence` when present, and
 *   `createdAt`. `tool.*` rows carry a stable `toolCallId` (or the provider's
 *   `toolUseId` alias) used to correlate overlapping tool calls.
 * - The environment shell's live observation (recorded by ingestion on the
 *   server clock): assistant/reasoning text and tool heartbeats keep a
 *   `lastProviderActivityAt` that advances even when provider part/tool
 *   timestamps stay pinned to the part or tool start. These live observations
 *   are merged in, never persisted, so a replay or hydration of stored rows
 *   cannot manufacture resumed progress.
 * - `OrchestrationLatestTurn` / `OrchestrationSession`: the current turn's
 *   `requestedAt`/`startedAt` and the session's active turn.
 *
 * Deliberately excluded as provider progress: user- and approval-driven
 * events (`user-input.*`, `approval.*`, `tool.denied`), token/metadata
 * bookkeeping (`context-window.updated` and usage-only `task.progress` rows),
 * checkpoints, and thread/project scaffolding. Transport heartbeats,
 * reconnects and UI renders are never activities, so they cannot masquerade
 * as progress.
 *
 * @module postStartActivity
 */
import type {
  OrchestrationLatestTurn,
  OrchestrationSession,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

import { compareDateTimeStrings } from "./dateTime.ts";

/**
 * Conservative default for the first slice. Five minutes is long enough that
 * ordinary reasoning pauses and slow first tokens do not trip it, and short
 * enough that a truly wedged turn becomes visible before a user gives up on
 * it. This is a display threshold only: it never aborts, settles, fails, or
 * otherwise mutates the turn.
 */
export const POST_START_SILENCE_THRESHOLD_MS = 5 * 60_000;

/**
 * A provider origin further ahead than this than the observing clock is not a
 * freshness signal — it is an unsupported clock relationship. Represent it as
 * honest uncertainty instead of clamping it to "just happened".
 */
export const POST_START_FUTURE_TOLERANCE_MS = 60_000;

export type PostStartOutstandingTool = {
  readonly toolCallId: string;
  /** Provider title, or a neutral fallback; never assistant prose. */
  readonly title: string;
  readonly itemType: string | null;
  readonly startedAt: string;
  /** Last `tool.updated`/`tool.progress` time for this call; the age signal when it stalls. */
  readonly lastObservedAt: string;
};

export type PostStartKnownWait = "approval" | "input";

/**
 * Provider progress observed directly by the server on its own clock. Unlike
 * persisted activity rows these advance on text/reasoning deltas and tool
 * heartbeats whose provider timestamps stay pinned to the start.
 */
export type PostStartLiveObservation = {
  readonly lastProviderActivityAt: string | null;
  readonly lastToolCompletedAt: string | null;
  readonly outstandingTools: ReadonlyArray<PostStartOutstandingTool>;
  /**
   * Tool ids the server has observed as completed this turn. Lets the merge
   * drop a stale live outstanding call when persisted rows already show it
   * finished (and vice versa).
   */
  readonly completedToolIds?: ReadonlyArray<string> | undefined;
  /**
   * Server clock instant the observation/shell was produced. Used as the
   * observation-time basis so provider ages are not compared to a browser
   * clock that may disagree. Absent on peers that predate the field.
   */
  readonly observedAt?: string | null | undefined;
  /**
   * The turn this live observation describes, or null while it describes the
   * accepted pending request (session `starting`, no provider turn id yet).
   * Carried so a client whose current turn no longer matches the cached
   * observation cannot consume another turn's recency or tools.
   */
  readonly turnId?: string | null | undefined;
};

export type PostStartActivityAnchors = {
  /** The turn being observed, or null when no turn is active. */
  readonly turnId: string | null;
  /** True only while the provider is expected to be producing output. */
  readonly active: boolean;
  /**
   * Trustworthy current-turn origin to fall back to when no provider event
   * ever arrived (`startedAt` once the provider accepted, else `requestedAt`).
   */
  readonly turnStartedAt: string | null;
  /** Last provider-originated activity in this turn, or null. */
  readonly lastProviderActivityAt: string | null;
  /** Last real tool completion in this turn, or null. */
  readonly lastToolCompletedAt: string | null;
  /** Outstanding tool calls in start order. */
  readonly outstandingTools: ReadonlyArray<PostStartOutstandingTool>;
  /** Most recently observed outstanding tool, or null. */
  readonly outstandingTool: PostStartOutstandingTool | null;
  /** A pending user decision explains the quiet; suppresses the warning. */
  readonly knownWait: PostStartKnownWait | null;
  /**
   * True when the server's own live observation is the basis for this turn's
   * ages, so the resolver should measure against the server clock.
   */
  readonly observingServerClock: boolean;
  /**
   * Server clock minus client clock, in milliseconds, estimated when the live
   * observation arrived. Null when the peer omitted its clock basis. A large
   * magnitude is an unsupported relationship, not a freshness signal.
   */
  readonly observationClockOffsetMs: number | null;
  /**
   * Client wall-clock instant the live observation was actually received.
   * Paired with `receivedMonotonicMs` so elapsed time since receipt can be
   * measured monotonically; a render, navigation or unrelated shell update is
   * not a new receipt and must not re-date the observation.
   */
  readonly receivedAtMs: number | null;
  /**
   * Client monotonic instant at receipt. Elapsed time is computed from this
   * baseline, so a browser wall-clock change between observations cannot
   * fabricate a silence age.
   */
  readonly receivedMonotonicMs: number | null;
};

export type PostStartActivityStatus = "inactive" | "active" | "quiet" | "waiting" | "unknown";

export type PostStartActivityObservation = {
  readonly status: PostStartActivityStatus;
  readonly lastProviderActivityAt: string | null;
  readonly lastProviderActivityAgeMs: number | null;
  readonly lastToolCompletedAt: string | null;
  readonly lastToolCompletedAgeMs: number | null;
  readonly outstandingTool: PostStartOutstandingTool | null;
  readonly outstandingToolAgeMs: number | null;
  /** Instant silence began, or null when not quiet. */
  readonly quietSinceAt: string | null;
  readonly quietForMs: number;
  /**
   * Stable identity of one silence episode (current turn + quiet origin).
   * A resumption changes it, so a later silence is a new episode. Equivalent
   * instants canonicalize to the same key regardless of offset.
   */
  readonly episodeKey: string | null;
};

export type PostStartConnectionState = "live" | "disconnected";

export type DerivePostStartActivityInput = {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly latestTurn: Pick<
    OrchestrationLatestTurn,
    "turnId" | "state" | "requestedAt" | "startedAt" | "completedAt"
  > | null;
  readonly session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null;
  /** From the shell's pending flags; a known wait is not silence. */
  readonly knownWait?: PostStartKnownWait | null;
  /**
   * Origin for a turn the server has accepted but not yet named (session
   * `starting`, `activeTurnId` null, and possibly no latest turn). The shell's
   * `latestUserMessageAt` is the submitted request time when present.
   */
  readonly pendingStartedAt?: string | null;
  /** Server-observed progress on its own clock; merged over persisted rows. */
  readonly live?: PostStartLiveObservation | null;
  /**
   * Client clock instant the live observation was received, used only to
   * estimate the server/client clock relationship. Omit it to fall back to
   * the local clock (older callers and tests).
   */
  readonly receivedAtMs?: number | null;
  /**
   * Client monotonic instant paired with `receivedAtMs` at the same receipt.
   * When both are supplied the resolver measures elapsed time monotonically,
   * so a wall-clock change cannot invent a silence age.
   */
  readonly receivedMonotonicMs?: number | null;
};

function parseMs(value: string | null | undefined): number | null {
  if (value == null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function maxTimestamp(left: string | null, right: string | null): string | null {
  const leftMs = parseMs(left);
  const rightMs = parseMs(right);
  if (leftMs === null && rightMs === null) return null;
  if (leftMs === null) return right;
  if (rightMs === null) return left;
  return leftMs >= rightMs ? left : right;
}

/**
 * A provider event that represents the provider doing work (or reporting a
 * failure). Everything else — user input, approvals, token metadata,
 * checkpoints, thread scaffolding — is intentionally not progress.
 */
export function isProviderActivityKind(kind: string): boolean {
  if (kind === "tool.denied") return false;
  return (
    kind.startsWith("tool.") ||
    kind.startsWith("task.") ||
    kind.startsWith("provider.") ||
    kind.startsWith("runtime.") ||
    kind === "turn.plan.updated" ||
    kind === "context-compaction"
  );
}

const TERMINAL_TOOL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "declined",
  "stopped",
]);

function payloadRecord(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  const payload = activity.payload;
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const next = value.trim();
  return next.length > 0 ? next : undefined;
}

/** Usage-only rows share a kind prefix with meaningful progress; exclude them. */
export function isMeaningfulProviderActivity(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): boolean {
  if (!isProviderActivityKind(activity.kind)) return false;
  const payload = activity.payload;
  const asRecord =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  return asRecord?.usageSnapshot !== true;
}

/** Providers name the same tool call `toolCallId` or the `toolUseId` alias. */
function toolCorrelationKey(payload: Record<string, unknown> | null): string | undefined {
  return trimmed(payload?.toolCallId) ?? trimmed(payload?.toolUseId);
}

function toolTitle(payload: Record<string, unknown> | null): string | undefined {
  return trimmed(payload?.title) ?? trimmed(payload?.toolName);
}

function activityOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (
    left.sequence !== undefined &&
    right.sequence !== undefined &&
    left.sequence !== right.sequence
  ) {
    return left.sequence - right.sequence;
  }
  if (left.sequence !== undefined && right.sequence === undefined) return 1;
  if (left.sequence === undefined && right.sequence !== undefined) return -1;
  const byTime = compareDateTimeStrings(left.createdAt, right.createdAt);
  if (byTime !== 0) return byTime;
  return left.id.localeCompare(right.id);
}

type OutstandingToolsDerivation = {
  readonly tools: ReadonlyArray<PostStartOutstandingTool>;
  readonly lastCompletedAt: string | null;
  /** Tool ids seen to complete in this turn; completion is terminal per id. */
  readonly completedToolIds: ReadonlySet<string>;
};

/**
 * Correlate tool lifecycles by `toolCallId`/`toolUseId`. A completion — whether
 * an explicit `tool.completed` or a terminal `tool.updated` status — clears
 * exactly the call it identifies, so overlapping tools never clear each other.
 * Completion is terminal for a tool id: a later progress/update for the same id
 * is a late update, not a new call, and must not reopen it. `tool.progress`
 * heartbeats advance the matching call's observation age without changing its
 * identity.
 */
function deriveOutstandingTools(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OutstandingToolsDerivation {
  const byKey = new Map<string, PostStartOutstandingTool>();
  const completedToolIds = new Set<string>();
  let lastCompletedAt: string | null = null;
  for (const activity of [...activities].sort(activityOrder)) {
    const payload = payloadRecord(activity);
    const key = toolCorrelationKey(payload);
    if (key === undefined) continue;

    if (activity.kind === "tool.started") {
      if (completedToolIds.has(key)) continue;
      byKey.set(key, {
        toolCallId: key,
        title: toolTitle(payload) ?? "Tool",
        itemType: trimmed(payload?.itemType) ?? null,
        startedAt: activity.createdAt,
        lastObservedAt: activity.createdAt,
      });
      continue;
    }

    if (activity.kind === "tool.completed") {
      byKey.delete(key);
      completedToolIds.add(key);
      lastCompletedAt = maxTimestamp(lastCompletedAt, activity.createdAt);
      continue;
    }

    if (activity.kind === "tool.updated" || activity.kind === "tool.progress") {
      const status = trimmed(payload?.status);
      if (
        activity.kind === "tool.updated" &&
        status !== undefined &&
        TERMINAL_TOOL_STATUSES.has(status)
      ) {
        byKey.delete(key);
        completedToolIds.add(key);
        lastCompletedAt = maxTimestamp(lastCompletedAt, activity.createdAt);
        continue;
      }
      if (completedToolIds.has(key)) continue;
      const existing = byKey.get(key);
      if (existing === undefined) {
        // An update/progress whose start aged out of retention still identifies
        // a live call; record it from the first observation we do have.
        byKey.set(key, {
          toolCallId: key,
          title: toolTitle(payload) ?? "Tool",
          itemType: trimmed(payload?.itemType) ?? null,
          startedAt: activity.createdAt,
          lastObservedAt: activity.createdAt,
        });
        continue;
      }
      byKey.set(key, {
        ...existing,
        title: toolTitle(payload) ?? existing.title,
        lastObservedAt:
          maxTimestamp(existing.lastObservedAt, activity.createdAt) ?? activity.createdAt,
      });
    }
  }
  return { tools: [...byKey.values()], lastCompletedAt, completedToolIds };
}

/**
 * Merge persisted and live tool observations by identity, keeping the latest
 * age, but never resurrect a call either source has seen complete. Stale live
 * evidence cannot reopen a persisted completion, and stale persisted evidence
 * cannot reopen a live completion.
 *
 * When the live observation supplies the clock basis, live evidence wins for a
 * call present in both sources. Persisted rows carry provider chronology, which
 * can sit far ahead of the server; maxing it in would let a skewed stored
 * timestamp beat a fresh server-observed heartbeat and under-report the tool's
 * real age.
 */
function mergeOutstandingTools(
  persisted: ReadonlyArray<PostStartOutstandingTool>,
  live: ReadonlyArray<PostStartOutstandingTool>,
  completedToolIds: ReadonlySet<string>,
  preferLiveTime: boolean,
): ReadonlyArray<PostStartOutstandingTool> {
  const byKey = new Map<string, PostStartOutstandingTool>();
  for (const tool of [...persisted, ...live]) {
    if (completedToolIds.has(tool.toolCallId)) continue;
    const existing = byKey.get(tool.toolCallId);
    if (existing === undefined) {
      byKey.set(tool.toolCallId, tool);
      continue;
    }
    if (preferLiveTime) {
      byKey.set(tool.toolCallId, { ...existing, ...tool });
      continue;
    }
    const existingMs = parseMs(existing.lastObservedAt);
    const nextMs = parseMs(tool.lastObservedAt);
    if (nextMs !== null && (existingMs === null || nextMs >= existingMs)) {
      byKey.set(tool.toolCallId, { ...existing, ...tool });
    }
  }
  return [...byKey.values()];
}

function latestOutstandingTool(
  tools: ReadonlyArray<PostStartOutstandingTool>,
): PostStartOutstandingTool | null {
  if (tools.length === 0) return null;
  return (
    [...tools]
      .sort((left, right) => compareDateTimeStrings(left.lastObservedAt, right.lastObservedAt))
      .at(-1) ?? null
  );
}

function isSessionActive(status: string | undefined): boolean {
  return status === "running" || status === "starting";
}

/**
 * Reduce the raw thread state to the stable anchors a ticking UI needs.
 * Call this when thread data changes; call `resolvePostStartActivity` on the
 * clock tick so only the notice re-renders each second.
 */
export function derivePostStartActivityAnchors(
  input: DerivePostStartActivityInput,
): PostStartActivityAnchors {
  const { latestTurn, session, live } = input;
  const sessionActive = isSessionActive(session?.status);
  const sessionActiveTurnId = session?.activeTurnId ?? null;

  // A stale session observation must not keep a terminal turn's warning alive:
  // if the latest turn names the session's active turn and has already ended,
  // the session state is lagging, not running.
  const latestTurnEndedForActiveTurn =
    latestTurn !== null &&
    sessionActiveTurnId !== null &&
    latestTurn.turnId === sessionActiveTurnId &&
    latestTurn.state !== "running";

  const pendingStart =
    session?.status === "starting" && sessionActiveTurnId === null && !latestTurnEndedForActiveTurn;
  const pendingStartedAt = input.pendingStartedAt ?? null;

  const turnId = latestTurnEndedForActiveTurn
    ? null
    : (sessionActiveTurnId ?? (latestTurn?.state === "running" ? latestTurn.turnId : null) ?? null);

  const active = latestTurnEndedForActiveTurn
    ? false
    : sessionActive && (turnId !== null || session?.status === "starting");

  const turnStartedAt =
    latestTurn?.turnId === turnId && turnId !== null
      ? parseMs(latestTurn.startedAt) !== null
        ? latestTurn.startedAt
        : latestTurn.requestedAt
      : pendingStart
        ? pendingStartedAt
        : null;

  // The server's live observation is the observation-time basis when present:
  // its instants are on the server clock, so a skewed persisted provider
  // timestamp must not be maxed into the age. Estimate the server/client offset
  // from the observation's own stamp when the client passed its receipt time.
  //
  // A cached observation belonging to a different turn must not supply this
  // turn's recency or tools: a live record naming a turn the client is not
  // currently on (or a pending record with no turn while a turn is named) is
  // stale evidence, not progress. A peer that omits the field entirely is
  // treated as unknown and accepted (forward/backward compatible).
  const liveTurnId = live?.turnId;
  const liveMatchesCurrentTurn =
    live != null &&
    (liveTurnId === undefined
      ? true
      : liveTurnId === null
        ? turnId === null
        : liveTurnId === turnId);
  const currentLive = liveMatchesCurrentTurn ? live : null;
  const observingServerClock = currentLive != null;
  const liveObservedAtMs = parseMs(currentLive?.observedAt ?? null);
  const receivedAtMs = input.receivedAtMs ?? null;
  const receivedMonotonicMs = input.receivedMonotonicMs ?? null;
  const observationClockOffsetMs =
    liveObservedAtMs !== null && receivedAtMs !== null ? liveObservedAtMs - receivedAtMs : null;

  if (!active) {
    return {
      turnId,
      active: false,
      turnStartedAt,
      lastProviderActivityAt: null,
      lastToolCompletedAt: null,
      outstandingTools: [],
      outstandingTool: null,
      knownWait: input.knownWait ?? null,
      observingServerClock,
      observationClockOffsetMs,
      receivedAtMs,
      receivedMonotonicMs,
    };
  }

  const turnActivities =
    turnId === null ? [] : input.activities.filter((activity) => activity.turnId === turnId);

  let lastProviderActivityAt: string | null = null;
  for (const activity of turnActivities) {
    if (!isMeaningfulProviderActivity(activity)) continue;
    lastProviderActivityAt = maxTimestamp(lastProviderActivityAt, activity.createdAt);
  }

  const derived = deriveOutstandingTools(turnActivities);
  const completedToolIds = new Set<string>([
    ...derived.completedToolIds,
    ...(currentLive?.completedToolIds ?? []),
  ]);
  const outstandingTools = mergeOutstandingTools(
    derived.tools,
    currentLive?.outstandingTools ?? [],
    completedToolIds,
    observingServerClock,
  );

  // Prefer the server clock for activity/completion recency; fall back to the
  // persisted provider chronology only when the server has no live observation.
  const liveLastActivity = currentLive?.lastProviderActivityAt ?? null;
  const liveLastCompleted = currentLive?.lastToolCompletedAt ?? null;

  return {
    turnId,
    active: true,
    turnStartedAt,
    lastProviderActivityAt: liveLastActivity ?? lastProviderActivityAt,
    lastToolCompletedAt: liveLastCompleted ?? derived.lastCompletedAt,
    outstandingTools,
    outstandingTool: latestOutstandingTool(outstandingTools),
    knownWait: input.knownWait ?? null,
    observingServerClock,
    observationClockOffsetMs,
    receivedAtMs,
    receivedMonotonicMs,
  };
}

/**
 * Resolve the anchors at a given instant. `nowMs` is injected so tests use a
 * controlled clock and the UI can tick without recomputing anchors.
 */
export function resolvePostStartActivity(
  anchors: PostStartActivityAnchors,
  nowMs: number,
  options: {
    readonly connection?: PostStartConnectionState;
    readonly thresholdMs?: number;
    readonly futureToleranceMs?: number;
    /**
     * Monotonic instant paired with `nowMs`. When the anchors carry their own
     * receipt baseline, this lets the resolver advance the basis by measured
     * monotonic elapsed time instead of trusting wall-clock movement.
     */
    readonly nowMonotonicMs?: number;
  } = {},
): PostStartActivityObservation {
  const thresholdMs = Math.max(0, options.thresholdMs ?? POST_START_SILENCE_THRESHOLD_MS);
  const futureToleranceMs = Math.max(
    0,
    options.futureToleranceMs ?? POST_START_FUTURE_TOLERANCE_MS,
  );
  const connection = options.connection ?? "live";

  // Elapsed time since the actual receipt, measured monotonically when the
  // anchors carry that baseline. A wall-clock change between observations
  // cannot then fabricate silence; without the baseline, fall back to wall now.
  const basisNowMs =
    typeof anchors.receivedAtMs === "number" &&
    typeof anchors.receivedMonotonicMs === "number" &&
    typeof options.nowMonotonicMs === "number"
      ? anchors.receivedAtMs + Math.max(0, options.nowMonotonicMs - anchors.receivedMonotonicMs)
      : nowMs;

  // Measured against the server clock when the live observation supplies the
  // basis; the browser clock only supplies elapsed time on top of it. A clock
  // relationship too far off to trust is honest uncertainty, never a warning.
  const clockUnsupported =
    anchors.observingServerClock &&
    anchors.observationClockOffsetMs !== null &&
    Math.abs(anchors.observationClockOffsetMs) > futureToleranceMs;
  const nowBasisMs =
    anchors.observationClockOffsetMs === null
      ? basisNowMs
      : basisNowMs + anchors.observationClockOffsetMs;

  const lastActivityMs = parseMs(anchors.lastProviderActivityAt);
  const lastActivityAgeMs =
    lastActivityMs === null ? null : Math.max(0, nowBasisMs - lastActivityMs);
  const lastToolCompletedMs = parseMs(anchors.lastToolCompletedAt);
  const lastToolCompletedAgeMs =
    lastToolCompletedMs === null ? null : Math.max(0, nowBasisMs - lastToolCompletedMs);
  const outstandingToolAgeMs =
    anchors.outstandingTool === null
      ? null
      : (() => {
          const observed = parseMs(anchors.outstandingTool.lastObservedAt);
          return observed === null ? null : Math.max(0, nowBasisMs - observed);
        })();

  const base = {
    lastProviderActivityAt: anchors.lastProviderActivityAt,
    lastProviderActivityAgeMs: lastActivityAgeMs,
    lastToolCompletedAt: anchors.lastToolCompletedAt,
    lastToolCompletedAgeMs,
    outstandingTool: anchors.outstandingTool,
    outstandingToolAgeMs,
  } as const;

  if (!anchors.active) {
    return { ...base, status: "inactive", quietSinceAt: null, quietForMs: 0, episodeKey: null };
  }

  // A disconnected environment cannot be observed. Show the last known
  // activity and say so; never assert the remote work stopped.
  if (connection === "disconnected") {
    return { ...base, status: "unknown", quietSinceAt: null, quietForMs: 0, episodeKey: null };
  }

  // Clocks that disagree beyond tolerance make every age untrustworthy; report
  // the known instants but not an age, and never assert silence.
  if (clockUnsupported) {
    return {
      ...base,
      lastProviderActivityAgeMs: null,
      lastToolCompletedAgeMs: null,
      outstandingToolAgeMs: null,
      status: "unknown",
      quietSinceAt: null,
      quietForMs: 0,
      episodeKey: null,
    };
  }

  // A pending approval/input is an explained wait, not unexplained silence.
  if (anchors.knownWait !== null) {
    return { ...base, status: "waiting", quietSinceAt: null, quietForMs: 0, episodeKey: null };
  }

  // With the server's own observation, the origin stays on the server clock; a
  // persisted provider `turnStartedAt` must not be maxed back in.
  const originAt =
    anchors.observingServerClock && anchors.lastProviderActivityAt !== null
      ? anchors.lastProviderActivityAt
      : maxTimestamp(anchors.lastProviderActivityAt, anchors.turnStartedAt);
  const originMs = parseMs(originAt);

  if (originAt === null || originMs === null) {
    // No activity and no trustworthy current-turn origin: be honest.
    return { ...base, status: "unknown", quietSinceAt: null, quietForMs: 0, episodeKey: null };
  }

  // An origin ahead of the observing clock is an unsupported clock
  // relationship, not freshness. Do not clamp it to "just happened" and claim
  // the turn is active; report honest uncertainty instead. The stored instant
  // stays known, but its age is not trustworthy.
  if (originMs - nowBasisMs > futureToleranceMs) {
    return {
      ...base,
      lastProviderActivityAgeMs:
        lastActivityMs !== null && lastActivityMs > nowBasisMs ? null : lastActivityAgeMs,
      lastToolCompletedAgeMs:
        lastToolCompletedMs !== null && lastToolCompletedMs > nowBasisMs
          ? null
          : lastToolCompletedAgeMs,
      outstandingToolAgeMs:
        anchors.outstandingTool !== null &&
        (parseMs(anchors.outstandingTool.lastObservedAt) ?? 0) > nowBasisMs
          ? null
          : outstandingToolAgeMs,
      status: "unknown",
      quietSinceAt: null,
      quietForMs: 0,
      episodeKey: null,
    };
  }

  const quietForMs = Math.max(0, nowBasisMs - originMs);
  if (quietForMs < thresholdMs) {
    return { ...base, status: "active", quietSinceAt: null, quietForMs, episodeKey: null };
  }

  // Equivalent instants (different offsets) canonicalize to one episode key,
  // so a re-hydration or a clock that moves the offset cannot fork identity.
  return {
    ...base,
    status: "quiet",
    quietSinceAt: originAt,
    quietForMs,
    episodeKey: `${anchors.turnId ?? "none"}:${originMs}`,
  };
}
