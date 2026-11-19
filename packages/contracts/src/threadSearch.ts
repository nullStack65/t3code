import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const OrchestrationThreadSearchSource = Schema.Literals(["user", "assistant"]);
export type OrchestrationThreadSearchSource = typeof OrchestrationThreadSearchSource.Type;

/**
 * Whose messages to keep: a founder's own, any person's (founders, people nobody has named yet
 * and guests), agents' and automations', the model's replies, or T3 Code's own notices.
 */
export const OrchestrationMessageSenderFilter = Schema.Literals([
  "kameron",
  "jeff",
  "people",
  "agents",
  "model",
  "system",
]);
export type OrchestrationMessageSenderFilter = typeof OrchestrationMessageSenderFilter.Type;

/**
 * The senders search can filter by. Search indexes only what people typed and the model's replies,
 * so agents' relays and T3 Code's notices are found only inside a thread.
 */
export const OrchestrationSearchSenderFilter = Schema.Literals([
  "kameron",
  "jeff",
  "people",
  "model",
]);
export type OrchestrationSearchSenderFilter = typeof OrchestrationSearchSenderFilter.Type;

/** Longer queries are cut to this before they are sent. */
export const THREAD_SEARCH_QUERY_MAX_LENGTH = 200;

// The server's SQLite client is synchronous and single-connection. Bound both
// scan input and response size so a search cannot monopolize that connection.
export const OrchestrationSearchThreadsInput = Schema.Struct({
  /** At least two characters, or empty with a `sender` to list that sender's newest messages. */
  query: TrimmedString.check(Schema.isMaxLength(THREAD_SEARCH_QUERY_MAX_LENGTH)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  /** Only messages from this sender. Older servers ignore it. */
  sender: Schema.optionalKey(OrchestrationSearchSenderFilter),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
  /**
   * How well the message matches: 1 for whole words, 0.8 when a word only
   * starts one, 0.3 when one only appears inside words, 0.25 more when the
   * words are written together as typed, else 0.1 more when they are near.
   * Older servers omit it.
   */
  quality: Schema.optionalKey(Schema.Finite),
  /** How many of the thread's newest messages match. Older servers omit it. */
  hits: Schema.optionalKey(Schema.Int),
  /** The message the snippet is from. Older servers omit it. */
  messageId: Schema.optionalKey(MessageId),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

export class OrchestrationSearchThreadsError extends Schema.TaggedError<OrchestrationSearchThreadsError>()(
  "OrchestrationSearchThreadsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
