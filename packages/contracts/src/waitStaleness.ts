import * as Schema from "effect/Schema";

export const StaleTimeoutMinutes = Schema.optional(Schema.Finite).annotate({
  description: "Idle timeout in minutes. Clamped to 5–1440 minutes.",
});

export const PR_WATCH_STALE_MINUTES = 30;
export const BACKGROUND_WAIT_STALE_MINUTES = 45;

// Stored on the owning application thread, independent of provider process lifetime.
export const ThreadStalenessWait = Schema.Struct({
  kind: Schema.Literals(["background", "delegate"]),
  taskId: Schema.String,
  staleTimeoutMs: Schema.Int,
  lastProgressAtMs: Schema.Finite,
  remoteHeld: Schema.optional(Schema.Boolean),
  alerted: Schema.optional(Schema.Literal(true)),
});
export type ThreadStalenessWait = typeof ThreadStalenessWait.Type;
