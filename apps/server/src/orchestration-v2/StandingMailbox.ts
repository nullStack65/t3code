import {
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2MailboxEntry,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  withMessageSenderNote,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

/**
 * Standing manager mailbox (Closura CLO-1303). Port of `plan_dequeue` in closura-agent-config
 * `scripts/lane_event_routing.py`; `laneEventRouting.conformance.json` is the shared contract.
 */
export type MailboxSenderRole = "founder" | "ceo" | "agent";

const MAILBOX_PRIORITY = { founder: 0, ceo: 1, agent: 2 } as const;

export interface MailboxMessage {
  readonly id: string;
  readonly at: string;
  readonly sender_role?: string | undefined;
  readonly kind?: string | undefined;
}

export interface MailboxPlan {
  readonly turns: 0 | 1;
  readonly batch: ReadonlyArray<string>;
  readonly digest: ReadonlyArray<string>;
  readonly preempt: boolean;
}

export function mailboxPriority(role: string | undefined): number {
  return role === "founder" ? MAILBOX_PRIORITY.founder : role === "ceo" ? MAILBOX_PRIORITY.ceo : 2;
}

/**
 * One turn for every actionable queued message, founder first, then CEO, then arrival order.
 * Digest items start no turn. A founder message preempts any turn it outranks; a CEO message
 * preempts only an agent-initiated turn; agent messages never preempt.
 */
export function planDequeue(
  queued: ReadonlyArray<MailboxMessage>,
  currentPriority: number | null = null,
): MailboxPlan {
  const digest = queued.filter((message) => message.kind === "digest");
  const actionable = queued
    .filter((message) => message.kind !== "digest")
    .toSorted(
      (left, right) =>
        mailboxPriority(left.sender_role) - mailboxPriority(right.sender_role) ||
        (left.at < right.at ? -1 : left.at > right.at ? 1 : 0),
    );
  const top = actionable[0] === undefined ? null : mailboxPriority(actionable[0].sender_role);
  return {
    turns: actionable.length > 0 ? 1 : 0,
    batch: actionable.map((message) => message.id),
    digest: digest.map((message) => message.id),
    preempt:
      top !== null &&
      currentPriority !== null &&
      top < currentPriority &&
      top <= MAILBOX_PRIORITY.ceo,
  };
}

/** The CEO seat is the standing thread named "CEO" (closura-agent-config `config/standing-threads.json`). */
function isCeoStandingName(name: string | null | undefined): boolean {
  return name?.trim().toUpperCase() === "CEO";
}

/** A person typing in the chat is the founder; a CEO standing thread is the CEO; the rest are agents. */
export function mailboxSenderRole(
  message: Pick<OrchestrationV2ConversationMessage, "createdBy" | "scheduledTaskId">,
  senderStandingName: string | null | undefined,
): MailboxSenderRole {
  if (message.createdBy === "user" && message.scheduledTaskId === undefined) return "founder";
  return isCeoStandingName(senderStandingName) ? "ceo" : "agent";
}

/** A standing-manager turn longer than this is flagged; the manager should dispatch, not do the work. */
const MANAGER_TURN_FLAG_SECONDS = 300;

export function managerTurnOverBudget(startedAtMs: number, completedAtMs: number): boolean {
  return (completedAtMs - startedAtMs) / 1000 > MANAGER_TURN_FLAG_SECONDS;
}

export type MailboxRoles = ReadonlyMap<MessageId, MailboxSenderRole>;

/** Founder first, then CEO, then the existing delivery order (the sort is stable). */
export function rankQueuedRunsByMailbox<T extends Pick<OrchestrationV2Run, "userMessageId">>(
  runs: ReadonlyArray<T>,
  roles: MailboxRoles,
): Array<T> {
  return runs.toSorted(
    (left, right) =>
      mailboxPriority(roles.get(left.userMessageId)) -
      mailboxPriority(roles.get(right.userMessageId)),
  );
}

/**
 * Only plain text another agent queued joins a batch. Attachments, commands, completions,
 * notifications (PR-watch wakes included), structured-output asks and continuations keep their
 * own turn, as does anything a person typed, so the transcript still shows it.
 */
function joinsBatch(
  run: OrchestrationV2Run,
  message: OrchestrationV2ConversationMessage | undefined,
  head: Pick<OrchestrationV2Run, "providerInstanceId" | "modelSelection">,
  now: DateTime.Utc,
): message is OrchestrationV2ConversationMessage {
  const deliveryClass = run.delivery?.class;
  const expiresAt = run.delivery?.expiresAt;
  return (
    message !== undefined &&
    message.createdBy !== "user" &&
    (deliveryClass === undefined || deliveryClass === "next_turn") &&
    (expiresAt === undefined || DateTime.isGreaterThan(expiresAt, now)) &&
    run.queueHeld !== true &&
    run.providerInstanceId === head.providerInstanceId &&
    run.modelSelection.model === head.modelSelection.model &&
    run.restartContinuationOfRunId === undefined &&
    run.manualContinuationOfRunId === undefined &&
    run.usageLimitContinuationOfRunId === undefined &&
    run.providerFailoverOfRunId === undefined &&
    run.steerWhenReadyRunId === undefined &&
    run.delegatedTaskId === undefined &&
    run.sourcePlanRef === undefined &&
    run.workspacePreparation === undefined &&
    run.outputSchema === undefined &&
    run.freshContext !== true &&
    message.attachments.length === 0 &&
    message.notification === undefined &&
    message.delegatedCompletion === undefined &&
    message.idleCompaction === undefined &&
    message.text.trim() !== "" &&
    !/^\s*[/$]/u.test(message.text)
  );
}

/** The other queued messages a starting standing-thread turn answers too, in mailbox order. */
export function mailboxFold(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  head: Pick<OrchestrationV2Run, "id" | "providerInstanceId" | "modelSelection">,
  roles: MailboxRoles,
  now: DateTime.Utc,
): {
  readonly folded: ReadonlyArray<OrchestrationV2Run>;
  readonly mailbox: ReadonlyArray<OrchestrationV2MailboxEntry>;
} {
  const folded: Array<OrchestrationV2Run> = [];
  const mailbox: Array<OrchestrationV2MailboxEntry> = [];
  const waiting = queuedRunsInDeliveryOrder(projection).filter((run) => run.id !== head.id);
  for (const run of rankQueuedRunsByMailbox(waiting, roles)) {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    if (!joinsBatch(run, message, head, now)) continue;
    folded.push(run);
    mailbox.push({
      messageId: message.id,
      runId: run.id,
      senderRole: roles.get(message.id) ?? "agent",
      requestedAt: run.requestedAt,
      text: withMessageSenderNote(message, message.text),
    });
  }
  return { folded, mailbox };
}

/** Appends the batched messages after the turn's own message, in mailbox order. */
export function formatMailboxForProvider(
  text: string,
  mailbox: ReadonlyArray<Pick<OrchestrationV2MailboxEntry, "senderRole" | "text">> | undefined,
): string {
  if (mailbox === undefined || mailbox.length === 0) return text;
  const noun = mailbox.length === 1 ? "message was" : "messages were";
  return [
    text,
    "",
    `<queued-messages count="${mailbox.length}">`,
    `${mailbox.length} more ${noun} queued for this thread. Answer them in this same turn:`,
    ...mailbox.map((entry, index) => `## ${index + 1} (${entry.senderRole})\n${entry.text.trim()}`),
    "</queued-messages>",
  ].join("\n");
}
