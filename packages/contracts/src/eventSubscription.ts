import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Fine-grained per-agent event subscriptions.
 * Phase 1 delivers pull-request URL selectors and thread-id selectors.
 * Repository, label, path-glob, tag, and domain selectors are typed and rejected until implemented.
 * Webhook and external sources are typed and rejected until phase 2.
 */

export const ExternalEventSource = Schema.Literals([
  "linear",
  "fleet_health_sentinel",
  "approvals_queue",
  "quo",
  "gmail",
]);
export type ExternalEventSource = typeof ExternalEventSource.Type;

export const PullRequestEventFilter = Schema.Union([
  Schema.Struct({ name: Schema.Literal("checks.required_passed") }),
  Schema.Struct({
    name: Schema.Literal("checks.failed"),
    exclude: Schema.optional(Schema.Array(Schema.Literal("cancelled"))),
  }),
  Schema.Struct({ name: Schema.Literal("review.changes_requested") }),
  Schema.Struct({ name: Schema.Literal("review.approved") }),
  Schema.Struct({ name: Schema.Literal("comment.human") }),
  Schema.Struct({ name: Schema.Literal("conflict.detected") }),
  Schema.Struct({ name: Schema.Literal("merged") }),
]);
export type PullRequestEventFilter = typeof PullRequestEventFilter.Type;

/** Names match the thread-alert kinds the server already judges. */
export const ThreadEventFilter = Schema.Struct({
  name: Schema.Literals(["lane-ended", "promise-without-wake", "stuck", "needs-person"]),
});
export type ThreadEventFilter = typeof ThreadEventFilter.Type;

export const EventFilter = Schema.Union([PullRequestEventFilter, ThreadEventFilter]);
export type EventFilter = typeof EventFilter.Type;

export const PullRequestSelector = Schema.Union([
  Schema.Struct({
    entity: Schema.Literal("pull_request"),
    by: Schema.Literal("url"),
    url: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    entity: Schema.Literal("pull_request"),
    by: Schema.Literal("repository"),
    repository: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    entity: Schema.Literal("pull_request"),
    by: Schema.Literal("label"),
    label: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    entity: Schema.Literal("pull_request"),
    by: Schema.Literal("path_glob"),
    pathGlob: TrimmedNonEmptyString,
  }),
]);
export type PullRequestSelector = typeof PullRequestSelector.Type;

export const ThreadSelector = Schema.Union([
  Schema.Struct({
    entity: Schema.Literal("thread"),
    by: Schema.Literal("thread_id"),
    threadId: ThreadId,
  }),
  Schema.Struct({
    entity: Schema.Literal("thread"),
    by: Schema.Literal("tag"),
    tag: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    entity: Schema.Literal("thread"),
    by: Schema.Literal("domain"),
    domain: TrimmedNonEmptyString,
  }),
]);
export type ThreadSelector = typeof ThreadSelector.Type;

export const ExternalSelector = Schema.Union([
  Schema.Struct({
    entity: Schema.Literal("webhook"),
    source: ExternalEventSource,
  }),
  Schema.Struct({
    entity: Schema.Literal("external"),
    source: ExternalEventSource,
  }),
]);
export type ExternalSelector = typeof ExternalSelector.Type;

export const EventSelector = Schema.Union([PullRequestSelector, ThreadSelector, ExternalSelector]);
export type EventSelector = typeof EventSelector.Type;

export const QuietHours = Schema.Struct({
  start: TrimmedNonEmptyString,
  end: TrimmedNonEmptyString,
  timeZone: TrimmedNonEmptyString,
});
export type QuietHours = typeof QuietHours.Type;

/**
 * `coalesceWindowSeconds` null means immediate. The other fields are stored only when the
 * reactor enforces them; a subscribe call that asks for a policy this build does not enforce
 * is rejected instead of stored.
 */
export const EventDeliveryPolicy = Schema.Struct({
  coalesceWindowSeconds: Schema.NullOr(NonNegativeInt),
  autoExpireOnClose: Schema.Boolean,
  onlyWhenIdle: Schema.Boolean,
  quietHours: Schema.NullOr(QuietHours),
  maxWakesPerHour: Schema.NullOr(PositiveInt),
});
export type EventDeliveryPolicy = typeof EventDeliveryPolicy.Type;

export const EventSubscription = Schema.Struct({
  id: TrimmedNonEmptyString,
  subscriberThreadId: ThreadId,
  selector: EventSelector,
  /** Null keeps the legacy pull-request wake set, minus ignored authors. */
  events: Schema.NullOr(Schema.Array(EventFilter)),
  ignoreAuthors: Schema.Array(TrimmedNonEmptyString),
  delivery: EventDeliveryPolicy,
  createdAt: IsoDateTime,
  coalesceUntilMs: Schema.NullOr(Schema.Number),
  pendingSummaries: Schema.Array(Schema.String),
  wakeTimesMs: Schema.Array(Schema.Number),
  deliveredSignatures: Schema.Record(Schema.String, Schema.String),
});
export type EventSubscription = typeof EventSubscription.Type;

export class EventSubscriptionPhase2Error extends Schema.TaggedError<EventSubscriptionPhase2Error>()(
  "EventSubscriptionPhase2Error",
  {
    entity: Schema.Literals(["webhook", "external"]),
    source: ExternalEventSource,
  },
) {
  override get message(): string {
    return `${this.entity} subscriptions for ${this.source} are not active until phase 2.`;
  }
}

export class EventSubscriptionSelectorUnsupportedError extends Schema.TaggedError<EventSubscriptionSelectorUnsupportedError>()(
  "EventSubscriptionSelectorUnsupportedError",
  {
    entity: Schema.Literals(["pull_request", "thread"]),
    by: Schema.String,
  },
) {
  override get message(): string {
    return `Selecting a ${this.entity} by ${this.by} is not active yet. Use a pull request URL or a thread id.`;
  }
}

export class EventSubscriptionInvalidError extends Schema.TaggedError<EventSubscriptionInvalidError>()(
  "EventSubscriptionInvalidError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
