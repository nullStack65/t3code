import type {
  Founder,
  GuestMessageAttribution,
  OrchestrationMessageSenderFilter,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2LinkedSender,
  OrchestrationV2MessageSentBy,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";

import { resolveUserMessagePresentation } from "./userMessage.ts";

/**
 * Who sent one message in a thread, from what the message itself records. Nothing here guesses:
 * a person's message from before senders were stamped is `person` with `sentBy: null`.
 */
export type MessageSender =
  | {
      readonly kind: "person";
      /** The signed-in client it came from, or null when the message predates that record. */
      readonly sentBy: OrchestrationV2MessageSentBy | null;
    }
  | { readonly kind: "guest"; readonly name: string }
  | {
      readonly kind: "agent";
      /** The thread that sent it, when the message names one. */
      readonly senderThreadId: ThreadId | null;
      readonly linkedSender: OrchestrationV2LinkedSender | null;
    }
  | { readonly kind: "automation"; readonly scheduledTaskId: ScheduledTaskId | null }
  | { readonly kind: "system" }
  | {
      readonly kind: "model";
      /** The provider and model of the run that wrote it, when known. */
      readonly provider: string | null;
      readonly model: string | null;
    };

export interface MessageSenderInput {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor | undefined;
  readonly creationSource?: OrchestrationV2CreationSource | undefined;
  readonly scheduledTaskId?: ScheduledTaskId | undefined;
  readonly senderThreadId?: ThreadId | undefined;
  readonly linkedSender?: OrchestrationV2LinkedSender | undefined;
  readonly sentBy?: OrchestrationV2MessageSentBy | undefined;
  readonly idleCompaction?: unknown;
  readonly context?: { readonly guest?: GuestMessageAttribution | undefined } | undefined;
}

/** The provider and model of the run behind an assistant message, as the client knows them. */
export interface MessageSenderModel {
  readonly provider: string | null;
  readonly model: string | null;
}

/**
 * Keep in step with `messageSenderCondition` in the server's thread search, which sorts stored
 * messages the same way in SQL.
 */
export function resolveMessageSender(
  message: MessageSenderInput,
  model?: MessageSenderModel | null,
): MessageSender {
  if (message.role === "assistant") {
    return { kind: "model", provider: model?.provider ?? null, model: model?.model ?? null };
  }
  if (message.role !== "user") return { kind: "system" };
  const presentation = resolveUserMessagePresentation(message);
  if (presentation.attribution === "guest") {
    return { kind: "guest", name: presentation.guestName ?? "Guest" };
  }
  if (message.idleCompaction !== undefined) return { kind: "system" };
  // The server's stamp of a person's client outranks rules read from client-chosen text or ids,
  // so a person cannot dress a message up as an automation or T3 Code.
  if (message.sentBy !== undefined && message.createdBy !== "agent") {
    return { kind: "person", sentBy: message.sentBy };
  }
  if (presentation.attribution === "automation") {
    return { kind: "automation", scheduledTaskId: presentation.scheduledTaskId ?? null };
  }
  if (message.senderThreadId !== undefined || message.linkedSender !== undefined) {
    return {
      kind: "agent",
      senderThreadId: message.senderThreadId ?? null,
      linkedSender: message.linkedSender ?? null,
    };
  }
  if (presentation.attribution === "t3code" || message.createdBy === "system") {
    return { kind: "system" };
  }
  if (presentation.attribution === "agent") {
    return { kind: "agent", senderThreadId: null, linkedSender: null };
  }
  return { kind: "person", sentBy: message.sentBy ?? null };
}

const FOUNDER_NAMES = { kameron: "Kameron", jeff: "Jeff" } satisfies Record<Founder, string>;

/** The initial and name on a shared-thread message. */
export function founderSenderBadge(founder: Founder) {
  const name = FOUNDER_NAMES[founder];
  return { name, initial: name.slice(0, 1) } as const;
}

const DEVICE_TYPE_NAMES = {
  desktop: "Desktop",
  mobile: "Phone",
  tablet: "Tablet",
  bot: "Bot client",
  unknown: "Unknown device",
} satisfies Record<OrchestrationV2MessageSentBy["deviceType"], string>;

/** The person's name when someone assigned the client to them, else null. */
export function messageSenderFounder(sender: MessageSender): Founder | null {
  return sender.kind === "person" ? (sender.sentBy?.founder ?? null) : null;
}

/** The client a person sent from, by its name in Connections, else by its kind. */
export function messageSenderDevice(sentBy: OrchestrationV2MessageSentBy): string {
  return sentBy.device.trim() || DEVICE_TYPE_NAMES[sentBy.deviceType];
}

/**
 * A short name for who sent a message. `agentTitle` names a sending thread the caller has looked
 * up; without it an agent is "Agent". A person nobody has named yet is "Unknown person", and a
 * message from before senders were recorded is "Unknown sender".
 */
export function messageSenderLabel(sender: MessageSender, agentTitle?: string | null): string {
  switch (sender.kind) {
    case "person":
      if (sender.sentBy === null) return "Unknown sender";
      return sender.sentBy.founder === null
        ? "Unknown person"
        : FOUNDER_NAMES[sender.sentBy.founder];
    case "guest":
      return `${sender.name} (guest)`;
    case "agent":
      return agentTitle?.trim() || sender.linkedSender?.title.trim() || "Agent";
    case "automation":
      return "Automation";
    case "system":
      return "T3 Code";
    case "model":
      return sender.provider ?? "Model";
  }
}

/** What follows the name: the client a person used, or the model that replied. */
export function messageSenderDetail(sender: MessageSender): string | null {
  if (sender.kind === "person") {
    return sender.sentBy === null ? null : messageSenderDevice(sender.sentBy);
  }
  if (sender.kind === "model") return sender.model;
  return null;
}

/** Whether a message from `sender` belongs under a "From" filter. */
export function messageSenderMatches(
  sender: MessageSender,
  filter: OrchestrationMessageSenderFilter,
): boolean {
  switch (filter) {
    case "kameron":
    case "jeff":
      return messageSenderFounder(sender) === filter;
    case "people":
      return sender.kind === "person" || sender.kind === "guest";
    case "agents":
      return sender.kind === "agent" || sender.kind === "automation";
    case "model":
      return sender.kind === "model";
    case "system":
      return sender.kind === "system";
  }
}

export const MESSAGE_SENDER_FILTER_LABELS = {
  kameron: "Kameron",
  jeff: "Jeff",
  people: "People",
  agents: "Agents and automations",
  model: "Model replies",
  system: "T3 Code",
} satisfies Record<OrchestrationMessageSenderFilter, string>;

/** Two messages share a heading when the same sender wrote both. */
export function sameMessageSender(left: MessageSender, right: MessageSender): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "person": {
      const other = right as typeof left;
      if (left.sentBy === null || other.sentBy === null) return left.sentBy === other.sentBy;
      return left.sentBy.founder !== null || other.sentBy.founder !== null
        ? left.sentBy.founder === other.sentBy.founder
        : left.sentBy.sessionId === other.sentBy.sessionId;
    }
    case "guest":
      return left.name === (right as typeof left).name;
    case "agent": {
      const other = right as typeof left;
      return (
        left.senderThreadId === other.senderThreadId &&
        left.linkedSender?.threadId === other.linkedSender?.threadId
      );
    }
    case "model": {
      const other = right as typeof left;
      return left.provider === other.provider && left.model === other.model;
    }
    default:
      return true;
  }
}
