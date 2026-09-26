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
};

const TERMINAL_TOOL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "declined",
  "stopped",
]);

interface ThreadObservationState {
  lastProviderActivityAt: string | null;
  lastToolCompletedAt: string | null;
  readonly tools: Map<string, PostStartOutstandingTool>;
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
     * Record one persisted activity row's normalized event. `observedAt` is the
     * server clock instant the event was observed, not the provider timestamp.
     */
    readonly recordActivity: (
      threadId: string,
      observedAt: string,
      activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
    ) => void;

    /** Assistant/reasoning text progress, which has no activity row of its own. */
    readonly recordContentProgress: (threadId: string, observedAt: string) => void;

    /** Turn ended or session died: the observation no longer describes live work. */
    readonly clearThread: (threadId: string) => void;

    readonly getThreadPostStartActivity: (threadId: string) => ThreadPostStartActivity | null;
  }
>()("t3/orchestration/ThreadPostStartActivity/ThreadPostStartActivityService") {}

export function make(): ThreadPostStartActivityService["Service"] {
  const stateByThreadId = new Map<string, ThreadObservationState>();

  const stateFor = (threadId: string): ThreadObservationState => {
    const existing = stateByThreadId.get(threadId);
    if (existing) return existing;
    const created: ThreadObservationState = {
      lastProviderActivityAt: null,
      lastToolCompletedAt: null,
      tools: new Map(),
    };
    stateByThreadId.set(threadId, created);
    return created;
  };

  return {
    recordActivity: (threadId, observedAt, activity) => {
      if (!isMeaningfulProviderActivity({ kind: activity.kind, payload: activity.payload })) {
        return;
      }
      const state = stateFor(threadId);
      state.lastProviderActivityAt = maxTimestamp(state.lastProviderActivityAt, observedAt);

      const payload = record(activity.payload);
      const key = trimmed(payload?.toolCallId) ?? trimmed(payload?.toolUseId);
      if (key === undefined) return;

      if (activity.kind === "tool.started") {
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
          state.lastToolCompletedAt = maxTimestamp(state.lastToolCompletedAt, observedAt);
          return;
        }
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

    recordContentProgress: (threadId, observedAt) => {
      const state = stateFor(threadId);
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
      };
    },
  };
}

export const layer = Layer.effect(ThreadPostStartActivityService, Effect.sync(make));
