import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type RunId,
} from "@t3tools/contracts";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import {
  compactDynamicToolOutput,
  SEND_TO_USER_TOOL_NAME,
  SILENT_ACK_TOOL_NAME,
} from "@t3tools/shared/toolOutput";

const OUTPUT_GATE_BOUNCE_MESSAGE_PREFIX = "message:output-gate-bounce:";

export const OUTPUT_GATE_BOUNCE_PROMPT =
  "Triggered by an agent/automation wake, not the user. Plain assistant text stays folded and is not delivered. Route your response now: call `send_to_user` if it is for the founder, `t3_thread_send` or `ask_agent` if it is for another agent, or `silent_ack` if nothing needs delivery.";

const EXPLICIT_CHANNEL_TOOL_IDS: ReadonlySet<string> = new Set([
  SEND_TO_USER_TOOL_NAME,
  SILENT_ACK_TOOL_NAME,
  "t3_thread_send",
  "t3_thread_send_attachments",
  "ask_agent",
]);

export function outputGateBounceCommandId(runId: RunId): CommandId {
  return CommandId.make(`server:output-gate-bounce:${runId}`);
}

export function outputGateBounceMessageId(runId: RunId): MessageId {
  return MessageId.make(`${OUTPUT_GATE_BOUNCE_MESSAGE_PREFIX}${runId}`);
}

function isOutputGateBounceMessageId(messageId: MessageId | null | undefined): boolean {
  return typeof messageId === "string" && messageId.startsWith(OUTPUT_GATE_BOUNCE_MESSAGE_PREFIX);
}

/** Recognizes explicit user/agent channel sinks across raw and provider-prefixed MCP tool names. */
export function isExplicitChannelToolName(toolName: string | null | undefined): boolean {
  if (typeof toolName !== "string" || toolName.length === 0) return false;
  if (EXPLICIT_CHANNEL_TOOL_IDS.has(toolName)) return true;
  const resolved = resolveT3McpToolId(toolName);
  if (resolved !== null && EXPLICIT_CHANNEL_TOOL_IDS.has(resolved)) return true;
  for (const id of EXPLICIT_CHANNEL_TOOL_IDS) {
    if (toolName.endsWith(`__${id}`)) return true;
  }
  return false;
}

/**
 * Only async agent/automation-originated turns are eligible for the turn-end output gate.
 * Human user turns (`createdBy === "user"` with no agent/automation wake metadata) are never gated.
 */
function isAgentOriginatedWake(
  message:
    | Pick<
        OrchestrationV2ConversationMessage,
        | "createdBy"
        | "creationSource"
        | "notification"
        | "scheduledTaskId"
        | "senderThreadId"
        | "linkedSender"
      >
    | undefined,
): boolean {
  if (message === undefined) return false;
  if (message.createdBy === "agent") return true;
  if (message.createdBy === "user") return false;
  return (
    message.notification !== undefined ||
    message.scheduledTaskId !== undefined ||
    message.senderThreadId !== undefined ||
    message.linkedSender !== undefined
  );
}

export type AgentOutputGateDecision =
  | {
      readonly action: "allow";
      readonly reason:
        | "not_completed"
        | "thread_inactive"
        | "side_chat"
        | "subagent_thread"
        | "user_origin"
        | "explicit_channel"
        | "no_plain_text";
    }
  | { readonly action: "bounce"; readonly prompt: string }
  | {
      readonly action: "fail_open_fold";
      readonly reason: "bounce_exhausted" | "thread_settled" | "superseded_by_newer_run";
    };

export function evaluateAgentOutputGate(input: {
  readonly thread: Pick<
    OrchestrationV2AppThread,
    "deletedAt" | "archivedAt" | "lineage" | "replacedByThreadId" | "settledOverride"
  >;
  readonly run: Pick<OrchestrationV2Run, "id" | "status" | "userMessageId">;
  readonly userMessage:
    | Pick<
        OrchestrationV2ConversationMessage,
        | "createdBy"
        | "creationSource"
        | "notification"
        | "scheduledTaskId"
        | "senderThreadId"
        | "linkedSender"
      >
    | undefined;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly assistantMessages?: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "role" | "runId" | "text">
  >;
  /** True when another run is already active or queued after this completed run. */
  readonly hasNewerOrActiveRun?: boolean;
}): AgentOutputGateDecision {
  if (input.run.status !== "completed") {
    return { action: "allow", reason: "not_completed" };
  }
  if (
    input.thread.deletedAt !== null ||
    input.thread.archivedAt !== null ||
    input.thread.replacedByThreadId != null
  ) {
    return { action: "allow", reason: "thread_inactive" };
  }
  if (input.thread.lineage.sideChat === true) {
    return { action: "allow", reason: "side_chat" };
  }
  if (input.thread.lineage.relationshipToParent === "subagent") {
    return { action: "allow", reason: "subagent_thread" };
  }
  if (!isAgentOriginatedWake(input.userMessage)) {
    return { action: "allow", reason: "user_origin" };
  }

  const runItems = input.turnItems.filter((item) => item.runId === input.run.id);
  const usedExplicitChannel = runItems.some(
    (item) =>
      item.type === "dynamic_tool" &&
      item.status === "completed" &&
      isExplicitChannelToolName(item.toolName) &&
      compactDynamicToolOutput(item.output)?.isError !== true,
  );
  if (usedExplicitChannel) {
    return { action: "allow", reason: "explicit_channel" };
  }

  const hasPlainTextItem = runItems.some(
    (item) => item.type === "assistant_message" && item.text.trim().length > 0,
  );
  const hasPlainTextMessage = (input.assistantMessages ?? []).some(
    (message) =>
      message.role === "assistant" &&
      message.runId === input.run.id &&
      message.text.trim().length > 0,
  );
  if (!hasPlainTextItem && !hasPlainTextMessage) {
    return { action: "allow", reason: "no_plain_text" };
  }

  if (input.thread.settledOverride === "settled") {
    return { action: "fail_open_fold", reason: "thread_settled" };
  }
  if (input.hasNewerOrActiveRun === true) {
    return { action: "fail_open_fold", reason: "superseded_by_newer_run" };
  }
  if (isOutputGateBounceMessageId(input.run.userMessageId)) {
    return { action: "fail_open_fold", reason: "bounce_exhausted" };
  }

  return { action: "bounce", prompt: OUTPUT_GATE_BOUNCE_PROMPT };
}
