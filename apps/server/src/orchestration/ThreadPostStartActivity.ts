/**
 * ThreadPostStartActivityService - in-memory per-thread provider observation
 * for the post-start visibility surfaces (inline status and the environment
 * notification coordinator).
 *
 * Provider event timestamps are not trustworthy progress signals: OpenCode
 * stamps every delta of a part with the part's start time, and running-tool
 * timestamps can stay pinned to the tool start. Ingestion records each
 * meaningful provider observation on the server clock here, and the shell
 * query reads it at mapping time — no persistence, no migration (same pattern
 * as ThreadBackgroundLivenessService / ThreadPlanProgressService).
 *
 * Observations are scoped to the thread's current turn. A superseding turn
 * resets the record, and traffic carrying a superseded turn id is ignored, so
 * late events cannot refresh a newer turn or clear its evidence. Tools that
 * complete are remembered as completed, so a later late update cannot reopen
 * them.
 *
 * Because these observations are live-only, a server restart (or any replay
 * of stored events) cannot manufacture resumed progress: the registry is empty
 * until new provider events arrive, and the client falls back to the persisted
 * turn origin. Cleared when a turn ends or the session dies.
 *
 * @module ThreadPostStartActivityService
 */
import {
  isMeaningfulProviderActivity,
  type PostStartOutstandingTool,
} from "@t3tools/shared/postStartActivity";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type ThreadPostStartActivity = {
  readonly lastProviderActivityAt: string | null;
  readonly lastToolCompletedAt: string | null;
  readonly outstandingTools: ReadonlyArray<PostStartOutstandingTool>;
  readonly completedToolIds: ReadonlyArray<string>;
};

const TERMINAL_TOOL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "declined",
  "stopped",
]);

interface ThreadObservationState {
  /** The turn this record describes; null until a turn id is known. */
  turnId: string | null;
  lastProviderActivityAt: string | null;
  lastToolCompletedAt: string | null;
  readonly tools: Map<string, PostStartOutstandingTool>;
  readonly completedToolIds: Set<string>;
}

function parseMs(value: string | null): number | null {
  if (value === null) return null;
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

function record(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const next = value.trim();
  return next.length > 0 ? next : undefined;
}

export class ThreadPostStartActivityService extends Context.Service<
  ThreadPostStartActivityService,
  {
    /**
     * Start (or continue) observing a turn. A different turn id supersedes the
     * previous record: outstanding tools and completion memory reset so the new
     * turn never inherits the old turn's evidence.
     */
    readonly beginTurn: (threadId: string, turnId: string | null) => void;

    /**
     * Record one persisted activity row's normalized event. `observedAt` is the
     * server clock instant the event was observed, not the provider timestamp.
     * `turnId` scopes the observation to the current turn; events naming a
     * superseded turn are ignored.
     */
    readonly recordActivity: (
      threadId: string,
      observedAt: string,
      activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
      turnId?: string | null,
    ) => void;

    /** Assistant/reasoning text progress, which has no activity row of its own. */
    readonly recordContentProgress: (
      threadId: string,
      observedAt: string,
      turnId?: string | null,
    ) => void;

    /** Turn ended or session died: the observation no longer describes live work. */
    readonly clearThread: (threadId: string) => void;

    readonly getThreadPostStartActivity: (threadId: string) => ThreadPostStartActivity | null;
  }
>()("t3/orchestration/ThreadPostStartActivity/ThreadPostStartActivityService") {}

export function make(): ThreadPostStartActivityService["Service"] {
  const stateByThreadId = new Map<string, ThreadObservationState>();

  const emptyState = (turnId: string | null): ThreadObservationState => ({
    turnId,
    lastProviderActivityAt: null,
    lastToolCompletedAt: null,
    tools: new Map(),
    completedToolIds: new Set(),
  });

  /**
   * Resolve the state for an observation, or null when the event belongs to a
   * turn that has been superseded. Events with no turn id are accepted as the
   * current (only) turn so providers that omit turn identity still observe.
   */
  const stateForObservation = (
    threadId: string,
    turnId: string | null | undefined,
  ): ThreadObservationState | null => {
    const existing = stateByThreadId.get(threadId);
    if (existing === undefined) {
      return stateByThreadId.set(threadId, emptyState(turnId ?? null)).get(threadId)!;
    }
    if (turnId === undefined || turnId === null) return existing;
    if (existing.turnId === null) {
      existing.turnId = turnId;
      return existing;
    }
    if (existing.turnId !== turnId) return null;
    return existing;
  };

  return {
    beginTurn: (threadId, turnId) => {
      const existing = stateByThreadId.get(threadId);
      if (existing !== undefined && existing.turnId === turnId) return;
      stateByThreadId.set(threadId, emptyState(turnId));
    },

    recordActivity: (threadId, observedAt, activity, turnId) => {
      if (!isMeaningfulProviderActivity({ kind: activity.kind, payload: activity.payload })) {
        return;
      }
      const state = stateForObservation(threadId, turnId);
      if (state === null) return;
      state.lastProviderActivityAt = maxTimestamp(state.lastProviderActivityAt, observedAt);

      const payload = record(activity.payload);
      const key = trimmed(payload?.toolCallId) ?? trimmed(payload?.toolUseId);
      if (key === undefined) return;

      if (activity.kind === "tool.started") {
        if (state.completedToolIds.has(key)) return;
        state.tools.set(key, {
          toolCallId: key,
          title: trimmed(payload?.title) ?? trimmed(payload?.toolName) ?? "Tool",
          itemType: trimmed(payload?.itemType) ?? null,
          startedAt: observedAt,
          lastObservedAt: observedAt,
        });
        return;
      }

      if (activity.kind === "tool.completed") {
        state.tools.delete(key);
        state.completedToolIds.add(key);
        state.lastToolCompletedAt = maxTimestamp(state.lastToolCompletedAt, observedAt);
        return;
      }

      if (activity.kind === "tool.updated" || activity.kind === "tool.progress") {
        const status = trimmed(payload?.status);
        if (
          activity.kind === "tool.updated" &&
          status !== undefined &&
          TERMINAL_TOOL_STATUSES.has(status)
        ) {
          state.tools.delete(key);
          state.completedToolIds.add(key);
          state.lastToolCompletedAt = maxTimestamp(state.lastToolCompletedAt, observedAt);
          return;
        }
        if (state.completedToolIds.has(key)) return;
        const existing = state.tools.get(key);
        state.tools.set(key, {
          toolCallId: key,
          title: trimmed(payload?.title) ?? trimmed(payload?.toolName) ?? existing?.title ?? "Tool",
          itemType: trimmed(payload?.itemType) ?? existing?.itemType ?? null,
          startedAt: existing?.startedAt ?? observedAt,
          lastObservedAt: observedAt,
        });
      }
    },

    recordContentProgress: (threadId, observedAt, turnId) => {
      const state = stateForObservation(threadId, turnId);
      if (state === null) return;
      state.lastProviderActivityAt = maxTimestamp(state.lastProviderActivityAt, observedAt);
    },

    clearThread: (threadId) => {
      stateByThreadId.delete(threadId);
    },

    getThreadPostStartActivity: (threadId) => {
      const state = stateByThreadId.get(threadId);
      if (!state) return null;
      return {
        lastProviderActivityAt: state.lastProviderActivityAt,
        lastToolCompletedAt: state.lastToolCompletedAt,
        outstandingTools: [...state.tools.values()],
        completedToolIds: [...state.completedToolIds],
      };
    },
  };
}

export const layer = Layer.effect(ThreadPostStartActivityService, Effect.sync(make));
