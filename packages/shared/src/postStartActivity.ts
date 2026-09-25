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
 *   `createdAt`. `tool.*` rows carry a stable `toolCallId` used to correlate
 *   overlapping tool calls.
 * - `OrchestrationLatestTurn` / `OrchestrationSession`: the current turn's
 *   `requestedAt`/`startedAt` and the session's active turn.
 *
 * Deliberately excluded as provider progress: user- and approval-driven
 * events (`user-input.*`, `approval.*`, `tool.denied`), token/metadata
 * bookkeeping (`context-window.updated`), checkpoints, and thread/project
 * scaffolding. Transport heartbeats, reconnects and UI renders are never
 * activities, so they cannot masquerade as progress.
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

export type PostStartOutstandingTool = {
  readonly toolCallId: string;
  /** Provider title, or a neutral fallback; never assistant prose. */
  readonly title: string;
  readonly itemType: string | null;
  readonly startedAt: string;
  /** Last `tool.updated` time for this call; the age signal when it stalls. */
  readonly lastObservedAt: string;
};

export type PostStartKnownWait = "approval" | "input";

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
  /** Last real `tool.completed` in this turn, or null. */
  readonly lastToolCompletedAt: string | null;
  /** Outstanding tool calls in start order. */
  readonly outstandingTools: ReadonlyArray<PostStartOutstandingTool>;
  /** Most recently observed outstanding tool, or null. */
  readonly outstandingTool: PostStartOutstandingTool | null;
  /** A pending user decision explains the quiet; suppresses the warning. */
  readonly knownWait: PostStartKnownWait | null;
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
   * A resumption changes it, so a later silence is a new episode.
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

/**
 * Correlate tool lifecycles by `toolCallId`. A completion clears exactly the
 * call it identifies, so overlapping tools never clear each other. Rows
 * without a `toolCallId` cannot be correlated and are ignored rather than
 * guessed at from titles or prose.
 */
function deriveOutstandingTools(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<PostStartOutstandingTool> {
  const byToolCallId = new Map<string, PostStartOutstandingTool>();
  for (const activity of [...activities].sort(activityOrder)) {
    const payload = payloadRecord(activity);
    const toolCallId = trimmed(payload?.toolCallId);
    if (toolCallId === undefined) continue;

    if (activity.kind === "tool.started") {
      const startedAt = activity.createdAt;
      byToolCallId.set(toolCallId, {
        toolCallId,
        title: trimmed(payload?.title) ?? "Tool",
        itemType: trimmed(payload?.itemType) ?? null,
        startedAt,
        lastObservedAt: startedAt,
      });
      continue;
    }

    if (activity.kind === "tool.updated") {
      const status = trimmed(payload?.status);
      if (status !== undefined && TERMINAL_TOOL_STATUSES.has(status)) {
        byToolCallId.delete(toolCallId);
        continue;
      }
      const existing = byToolCallId.get(toolCallId);
      if (existing === undefined) {
        // An update whose start aged out of retention still identifies a live
        // call; record it from the first observation we do have.
        byToolCallId.set(toolCallId, {
          toolCallId,
          title: trimmed(payload?.title) ?? "Tool",
          itemType: trimmed(payload?.itemType) ?? null,
          startedAt: activity.createdAt,
          lastObservedAt: activity.createdAt,
        });
        continue;
      }
      byToolCallId.set(toolCallId, {
        ...existing,
        title: trimmed(payload?.title) ?? existing.title,
        lastObservedAt:
          maxTimestamp(existing.lastObservedAt, activity.createdAt) ?? activity.createdAt,
      });
      continue;
    }

    if (activity.kind === "tool.completed") {
      byToolCallId.delete(toolCallId);
    }
  }
  return [...byToolCallId.values()];
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
  const { latestTurn, session } = input;
  const turnId =
    session?.activeTurnId ?? (latestTurn?.state === "running" ? latestTurn.turnId : null);
  const active = isSessionActive(session?.status) && turnId !== null;

  const turnStartedAt =
    latestTurn?.turnId === turnId
      ? parseMs(latestTurn.startedAt) !== null
        ? latestTurn.startedAt
        : latestTurn.requestedAt
      : null;

  if (!active || turnId === null) {
    return {
      turnId,
      active: false,
      turnStartedAt,
      lastProviderActivityAt: null,
      lastToolCompletedAt: null,
      outstandingTools: [],
      outstandingTool: null,
      knownWait: input.knownWait ?? null,
    };
  }

  const turnActivities = input.activities.filter((activity) => activity.turnId === turnId);

  let lastProviderActivityAt: string | null = null;
  let lastToolCompletedAt: string | null = null;
  for (const activity of turnActivities) {
    if (!isProviderActivityKind(activity.kind)) continue;
    lastProviderActivityAt = maxTimestamp(lastProviderActivityAt, activity.createdAt);
    if (activity.kind === "tool.completed") {
      lastToolCompletedAt = maxTimestamp(lastToolCompletedAt, activity.createdAt);
    }
  }

  const outstandingTools = deriveOutstandingTools(turnActivities);
  const outstandingTool =
    outstandingTools.length === 0
      ? null
      : ([...outstandingTools]
          .sort((left, right) => compareDateTimeStrings(left.lastObservedAt, right.lastObservedAt))
          .at(-1) ?? null);

  return {
    turnId,
    active: true,
    turnStartedAt,
    lastProviderActivityAt,
    lastToolCompletedAt,
    outstandingTools,
    outstandingTool,
    knownWait: input.knownWait ?? null,
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
  } = {},
): PostStartActivityObservation {
  const thresholdMs = Math.max(0, options.thresholdMs ?? POST_START_SILENCE_THRESHOLD_MS);
  const connection = options.connection ?? "live";

  const lastActivityMs = parseMs(anchors.lastProviderActivityAt);
  const lastActivityAgeMs = lastActivityMs === null ? null : Math.max(0, nowMs - lastActivityMs);
  const lastToolCompletedMs = parseMs(anchors.lastToolCompletedAt);
  const lastToolCompletedAgeMs =
    lastToolCompletedMs === null ? null : Math.max(0, nowMs - lastToolCompletedMs);
  const outstandingToolAgeMs =
    anchors.outstandingTool === null
      ? null
      : (() => {
          const observed = parseMs(anchors.outstandingTool.lastObservedAt);
          return observed === null ? null : Math.max(0, nowMs - observed);
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

  // A pending approval/input is an explained wait, not unexplained silence.
  if (anchors.knownWait !== null) {
    return { ...base, status: "waiting", quietSinceAt: null, quietForMs: 0, episodeKey: null };
  }

  const originAt = maxTimestamp(anchors.lastProviderActivityAt, anchors.turnStartedAt);
  const originMs = parseMs(originAt);

  if (originAt === null || originMs === null) {
    // No activity and no trustworthy current-turn origin: be honest.
    return { ...base, status: "unknown", quietSinceAt: null, quietForMs: 0, episodeKey: null };
  }

  // A future origin (clock skew) is treated as "just happened", never a
  // negative or spurious age.
  const quietForMs = Math.max(0, nowMs - originMs);
  if (quietForMs < thresholdMs) {
    return { ...base, status: "active", quietSinceAt: null, quietForMs, episodeKey: null };
  }

  // Keep the anchor's original representation (with its original offset) so
  // the episode key is stable across ticks.
  const quietSinceAt = originAt;
  return {
    ...base,
    status: "quiet",
    quietSinceAt,
    quietForMs,
    episodeKey: `${anchors.turnId ?? "none"}:${quietSinceAt}`,
  };
}
