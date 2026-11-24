import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ThreadDecisionAsk, ThreadInbox, ThreadInboxRoutingPatch } from "./threadInbox.ts";
import { ThreadLinkedPullRequest } from "./threadPullRequest.ts";
import { StoredThreadStanding, ThreadStanding } from "./threadStanding.ts";
import { DelegationNudgeUpdate, StoredThreadDelegationNudge } from "./delegationNudge.ts";
import { ThreadTitleRegeneration } from "./threadTitle.ts";
import { ThreadCollaboration, ThreadCollaborationUpdate } from "./threadCollaboration.ts";

export function hasOnlyPairedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const ThreadMetadataTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
  description: "New concise display title. Required only when action is rename.",
});

const ThreadMetadataClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256))
  .check(
    Schema.makeFilter((value) =>
      hasOnlyPairedSurrogates(value)
        ? true
        : "clientRequestId must contain valid paired Unicode surrogates.",
    ),
  )
  .annotate({ description: "Stable idempotency key to reuse when retrying this mutation." });

export const ThreadMetadataMcpAction = Schema.Literals([
  "rename",
  "regenerate_title",
  "route",
  "request_decision",
  "resolve_decision",
  "set_standing",
  "set_delegation_nudge",
  "collaborate",
]);
export type ThreadMetadataMcpAction = typeof ThreadMetadataMcpAction.Type;

export const ThreadMetadataMcpUpdateInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  action: ThreadMetadataMcpAction,
  title: Schema.optional(ThreadMetadataTitle),
  inboxRouting: Schema.optional(ThreadInboxRoutingPatch),
  decision: Schema.optional(ThreadDecisionAsk),
  standing: Schema.optional(
    Schema.NullOr(ThreadStanding).annotate({
      description:
        "Required only when action is set_standing: a bot persona ({name, role?, avatarId, accent}) makes this a standing bot thread; null makes it an ordinary thread. Independent of pinning.",
    }),
  ),
  delegationNudge: Schema.optional(
    DelegationNudgeUpdate.annotate({
      description:
        "Required only when action is set_delegation_nudge: {enabled, thresholds?}. When on, the thread is reminded to delegate after that many of its own tool calls in one request (default [5, 10]). A thread cannot change its own setting.",
    }),
  ),
  // The schema shows each update's fields; its description says only what they cannot.
  collaboration: Schema.optional(
    ThreadCollaborationUpdate.annotate({
      description:
        "Only with collaborate. Room members are thread ids; open_room again to change them.",
    }),
  ),
  clientRequestId: Schema.optional(ThreadMetadataClientRequestId),
}).check(
  Schema.makeFilter((input) =>
    (input.action === "rename") === (input.title !== undefined) &&
    (input.action === "route") === (input.inboxRouting !== undefined) &&
    (input.action === "request_decision") === (input.decision !== undefined) &&
    (input.action === "set_standing") === (input.standing !== undefined) &&
    (input.action === "set_delegation_nudge") === (input.delegationNudge !== undefined) &&
    (input.action === "collaborate") === (input.collaboration !== undefined)
      ? true
      : "rename requires title; route requires inboxRouting; request_decision requires decision; set_standing requires standing; set_delegation_nudge requires delegationNudge; collaborate requires collaboration; other actions reject those fields.",
  ),
);
export type ThreadMetadataMcpUpdateInput = typeof ThreadMetadataMcpUpdateInput.Type;

export const ThreadMetadataMcpUpdateResult = Schema.Struct({
  threadId: ThreadId,
  action: ThreadMetadataMcpAction,
  commandId: CommandId,
  sequence: NonNegativeInt,
  title: Schema.String,
  titleRegeneration: Schema.NullOr(ThreadTitleRegeneration),
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  inbox: Schema.optionalKey(ThreadInbox),
  standing: Schema.optionalKey(StoredThreadStanding),
  delegationNudge: Schema.optionalKey(StoredThreadDelegationNudge),
  collaboration: Schema.optionalKey(ThreadCollaboration),
  /** Set when close_room lands: the text to post on Linear and save to memory. */
  roomRecord: Schema.optionalKey(
    Schema.Struct({
      linearIssue: Schema.NullOr(Schema.String),
      linearComment: Schema.String,
      memoryEntry: Schema.String,
    }),
  ),
  updatedAt: IsoDateTime,
});
export type ThreadMetadataMcpUpdateResult = typeof ThreadMetadataMcpUpdateResult.Type;
