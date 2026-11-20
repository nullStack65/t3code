import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";

/**
 * A delegation nudge reminds a coordinating thread to hand work off once it
 * starts doing that work itself. It is opt-in per thread and never blocks a
 * tool call; see docs/orchestration-v2/orchestrator-mcp-server.md.
 */

/** Tool calls in one run before the first and second reminders. */
export const DEFAULT_DELEGATION_NUDGE_THRESHOLDS: ReadonlyArray<number> = [5, 10];

/** Ascending, distinct and short, so each threshold fires at most once per run. */
export const DelegationNudgeThresholds = Schema.Array(PositiveInt).check(
  Schema.makeFilter((thresholds) =>
    thresholds.length === 0 || thresholds.length > 4
      ? "Give one to four thresholds."
      : thresholds.every((value, index) => index === 0 || value > thresholds[index - 1]!)
        ? true
        : "Thresholds must be strictly ascending.",
  ),
);

/** Who last changed the setting, so a thread cannot quietly retune its own reminders. */
export const DelegationNudgeChangedBy = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  /** An agent in another T3 thread, through `t3_thread_update`. */
  Schema.Struct({ kind: Schema.Literal("agent"), threadId: ThreadId }),
  /** An MCP client that is not running inside a T3 thread. */
  Schema.Struct({ kind: Schema.Literal("mcp_client") }),
]);
export type DelegationNudgeChangedBy = typeof DelegationNudgeChangedBy.Type;

export const ThreadDelegationNudge = Schema.Struct({
  enabled: Schema.Boolean,
  thresholds: DelegationNudgeThresholds,
  changedBy: DelegationNudgeChangedBy,
  changedAt: IsoDateTime,
});
export type ThreadDelegationNudge = typeof ThreadDelegationNudge.Type;

/** A stored value that no longer decodes reads as off, rather than failing the thread. */
export const StoredThreadDelegationNudge = Schema.NullOr(ThreadDelegationNudge).pipe(
  Schema.catchDecoding(() => Effect.succeedSome(null)),
);
export type StoredThreadDelegationNudge = typeof StoredThreadDelegationNudge.Type;

export const DelegationNudgeToolCount = Schema.Struct({
  name: Schema.String,
  count: PositiveInt,
});

/** What one run did while its thread had the nudge on. */
export const RunDelegationNudgeStats = Schema.Struct({
  countedToolCalls: NonNegativeInt,
  delegations: NonNegativeInt,
  nudgesFired: NonNegativeInt,
  /** Most-used counted tools, highest first. */
  topTools: Schema.Array(DelegationNudgeToolCount),
  /** A reminder the provider could not take mid-turn; the next run carries it as context. */
  deferredNote: Schema.optional(Schema.String),
});
export type RunDelegationNudgeStats = typeof RunDelegationNudgeStats.Type;

/** What `t3_thread_update` and clients may write. */
export const DelegationNudgeUpdate = Schema.Struct({
  enabled: Schema.Boolean,
  /** Omitted keeps the current thresholds, or the defaults when there are none. */
  thresholds: Schema.optional(DelegationNudgeThresholds),
});
export type DelegationNudgeUpdate = typeof DelegationNudgeUpdate.Type;
