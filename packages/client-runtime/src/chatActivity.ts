import * as DateTime from "effect/DateTime";
import {
  mentionedFounders,
  resolveTimelineVisibility,
  type OrchestrationV2RunStatus,
  type OrchestrationV2TimelineVisibility,
  type OrchestrationV2TurnItem,
  type RunId,
} from "@t3tools/contracts";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import {
  compactDynamicToolOutput,
  SEND_TO_USER_TOOL_NAME,
  SILENT_ACK_TOOL_NAME,
  sentMessageFromToolItem,
} from "@t3tools/shared/toolOutput";
import { resolveMessageSender, type MessageSenderInput } from "./messageSender.ts";

type ActivityMessage = MessageSenderInput & {
  readonly humanNote?: true;
  readonly timelineVisibility?: OrchestrationV2TimelineVisibility | undefined;
};

export interface ChatActivityEntry {
  readonly createdAt: string;
  readonly runId: RunId | null;
  readonly message?: ActivityMessage | undefined;
  readonly item?: OrchestrationV2TurnItem | undefined;
  /** True when the entry is an explicit user-facing card (e.g. `sent-message` from `send_to_user`). */
  readonly surfacesToUser?: boolean | undefined;
}

const SILENT_OR_AGENT_ROUTED_TOOL_IDS: ReadonlySet<string> = new Set([
  SILENT_ACK_TOOL_NAME,
  "t3_thread_send",
  "t3_thread_send_attachments",
  "ask_agent",
]);

const TERMINAL_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function resolveChannelToolId(toolName: string | null | undefined): string | null {
  if (typeof toolName !== "string" || toolName.length === 0) return null;
  const resolved = resolveT3McpToolId(toolName);
  if (resolved !== null) return resolved;
  if (toolName === SEND_TO_USER_TOOL_NAME || toolName.endsWith(`__${SEND_TO_USER_TOOL_NAME}`)) {
    return SEND_TO_USER_TOOL_NAME;
  }
  for (const id of SILENT_OR_AGENT_ROUTED_TOOL_IDS) {
    if (toolName === id || toolName.endsWith(`__${id}`)) return id;
  }
  return null;
}

function isCompletedSuccessfulTool(
  item: OrchestrationV2TurnItem | undefined,
): item is Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }> {
  return (
    item?.type === "dynamic_tool" &&
    item.status === "completed" &&
    compactDynamicToolOutput(item.output)?.isError !== true
  );
}

function isDecisionRequestItem(
  item: OrchestrationV2TurnItem | undefined,
): item is Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }> {
  return (
    item?.type === "dynamic_tool" &&
    item.status === "completed" &&
    resolveT3McpToolId(item.toolName) === "t3_thread_update" &&
    typeof item.input === "object" &&
    item.input !== null &&
    "action" in item.input &&
    item.input.action === "request_decision"
  );
}

export function activityItemNeedsAttention(item: OrchestrationV2TurnItem): boolean {
  return (
    item.status === "failed" ||
    item.type === "error" ||
    (item.type === "notification" &&
      (item.outcome === "failed" ||
        (item.source.kind === "monitor" &&
          [item.source.pullRequest, ...(item.source.otherPullRequests ?? [])].some(
            (pr) => pr?.section?.outcome === "failed",
          )))) ||
    ((item.type === "approval_request" || item.type === "user_input_request") &&
      (item.status === "pending" || item.status === "waiting"))
  );
}

export function chatActivityContext(
  entries: Iterable<ChatActivityEntry>,
  runs: ReadonlyArray<{ id: RunId; status?: OrchestrationV2RunStatus }>,
  includeOtherActivity: boolean,
  decisionRequestedAt?: string,
  /**
   * The thread sits in a founder's inbox, so the newest reply of an agent-started run is what put
   * it there. Folding it would leave the inbox row looking empty until the founder expands it.
   */
  keepLatestReply = false,
) {
  const agentRuns = new Set<RunId>();
  const directRuns = new Set<RunId>();
  const agentOrAutomationWakeRuns = new Set<RunId>();
  const humanRuns = new Set<RunId>();
  const silentOrAgentRoutedRuns = new Set<RunId>();
  const userSurfacingRuns = new Set<RunId>();
  const decisionRuns = new Set<RunId>();
  const attentionByRun = new Map<RunId, Set<string>>();
  const addAttention = (runId: RunId, id: string) => {
    const ids = attentionByRun.get(runId);
    if (ids) ids.add(id);
    else attentionByRun.set(runId, new Set([id]));
  };
  let firstReplyAfterDecision: RunId | undefined;
  const replyRuns: RunId[] = [];
  let pendingDecision: { runId: RunId; startedAt: string } | undefined;
  for (const { createdAt, runId, message, item, surfacesToUser } of entries) {
    if (!runId) continue;
    if (surfacesToUser) userSurfacingRuns.add(runId);
    if (message?.humanNote) userSurfacingRuns.add(runId);
    if (message?.timelineVisibility === "user_timeline") userSurfacingRuns.add(runId);
    if (message && !message.humanNote && mentionedFounders(message.text).length > 0) {
      userSurfacingRuns.add(runId);
    }
    if (message?.role === "user" && !message.humanNote) {
      const sender = resolveMessageSender(message);
      if (sender.kind === "person" || sender.kind === "guest") {
        humanRuns.add(runId);
      } else if (sender.kind === "agent" || sender.kind === "automation") {
        agentOrAutomationWakeRuns.add(runId);
      }
      if (
        sender.kind === "agent" ||
        (includeOtherActivity && sender.kind !== "person" && sender.kind !== "guest")
      ) {
        agentRuns.add(runId);
      } else {
        directRuns.add(runId);
      }
    }
    if (item?.type === "notification") {
      agentRuns.add(runId);
      agentOrAutomationWakeRuns.add(runId);
    }
    if (item) {
      if (
        item.timelineVisibility === "user_timeline" ||
        item.type === "proposed_plan" ||
        item.type === "secret_request" ||
        item.type === "link_request"
      ) {
        userSurfacingRuns.add(runId);
      }
      if (isCompletedSuccessfulTool(item)) {
        const channelToolId = resolveChannelToolId(item.toolName);
        if (
          channelToolId === SEND_TO_USER_TOOL_NAME ||
          sentMessageFromToolItem(item) !== undefined
        ) {
          userSurfacingRuns.add(runId);
        } else if (channelToolId !== null && SILENT_OR_AGENT_ROUTED_TOOL_IDS.has(channelToolId)) {
          silentOrAgentRoutedRuns.add(runId);
        }
      }
    }
    if (item && activityItemNeedsAttention(item)) addAttention(runId, item.id);
    if (isDecisionRequestItem(item)) {
      decisionRuns.add(runId);
      userSurfacingRuns.add(runId);
      const startedAt = item.startedAt === null ? createdAt : DateTime.formatIso(item.startedAt);
      if (
        decisionRequestedAt &&
        startedAt <= decisionRequestedAt &&
        (pendingDecision === undefined || startedAt >= pendingDecision.startedAt)
      ) {
        pendingDecision = { runId, startedAt };
      }
    }
    if (message?.role === "assistant" && !message.humanNote) replyRuns.push(runId);
    if (decisionRequestedAt && message?.role === "assistant" && createdAt >= decisionRequestedAt) {
      firstReplyAfterDecision ??= runId;
    }
  }
  if (decisionRequestedAt) {
    const runId = pendingDecision?.runId ?? firstReplyAfterDecision;
    if (runId) {
      decisionRuns.add(runId);
      addAttention(runId, decisionRequestedAt);
    }
  }
  for (const id of directRuns) agentRuns.delete(id);
  const activeRuns = new Set<RunId>();
  for (const run of runs) {
    if (run.status === "failed") addAttention(run.id, run.id);
    if (run.status !== undefined && !TERMINAL_RUN_STATUSES.has(run.status)) {
      activeRuns.add(run.id);
    }
  }
  // Agent/automation wakes that completed via `silent_ack` or pure agent-to-agent routing
  // (`t3_thread_send` / `t3_thread_send_attachments` / `ask_agent`) without surfacing anything to
  // the user are hidden completely (zero fold pill) on collapsed founder timelines.
  const hiddenSilentRuns = new Set<RunId>();
  for (const runId of silentOrAgentRoutedRuns) {
    if (
      agentOrAutomationWakeRuns.has(runId) &&
      !humanRuns.has(runId) &&
      !userSurfacingRuns.has(runId) &&
      !decisionRuns.has(runId) &&
      !attentionByRun.has(runId) &&
      !activeRuns.has(runId)
    ) {
      hiddenSilentRuns.add(runId);
    }
  }
  if (keepLatestReply) {
    for (let i = replyRuns.length - 1; i >= 0; i--) {
      const candidate = replyRuns[i]!;
      if (!hiddenSilentRuns.has(candidate)) {
        decisionRuns.add(candidate);
        break;
      }
    }
  }
  return { agentRuns, decisionRuns, attentionByRun, hiddenSilentRuns, includeOtherActivity };
}

export type ChatActivityContext = ReturnType<typeof chatActivityContext>;

export function isChatActivityMessage(
  message: ActivityMessage,
  runId: RunId | null,
  context: ChatActivityContext | undefined,
): boolean {
  // Whoever started the run only sets the default; a stamp on the message overrides it.
  return (
    resolveTimelineVisibility(
      message,
      isChatActivityByDefault(message, runId, context) ? "agent" : "user",
    ) === "agent_fold"
  );
}

/**
 * One timeline row can carry several items (a tool group, a subagent card). The row stands on its
 * own if any of them does, because folding it would hide that item; otherwise a stamp that says
 * `agent_fold` folds it. Undefined means nothing was stamped and the run's default applies.
 */
export function combineTimelineVisibilityStamps(
  stamps: Iterable<OrchestrationV2TimelineVisibility | undefined>,
): OrchestrationV2TimelineVisibility | undefined {
  let combined: OrchestrationV2TimelineVisibility | undefined;
  for (const stamp of stamps) {
    if (stamp === "user_timeline") return stamp;
    if (stamp !== undefined) combined = stamp;
  }
  return combined;
}

function isChatActivityByDefault(
  message: ActivityMessage,
  runId: RunId | null,
  context: ChatActivityContext | undefined,
): boolean {
  if (message.humanNote) return false;
  const sender = resolveMessageSender(message);
  switch (sender.kind) {
    case "person":
    case "guest":
      return false;
    case "agent":
      return mentionedFounders(message.text).length === 0;
    case "model":
      return (
        !!runId &&
        context?.agentRuns.has(runId) === true &&
        !context.decisionRuns.has(runId) &&
        mentionedFounders(message.text).length === 0
      );
    default:
      return context?.includeOtherActivity !== false;
  }
}

export function settledChatActivityTaskIds(item: OrchestrationV2TurnItem): readonly string[] {
  if (item.type === "subagent" && item.status === "completed") return [item.subagentId];
  if (
    item.type === "notification" &&
    item.source.kind === "delegated_task" &&
    item.outcome === "completed"
  )
    return item.source.taskIds;
  return [];
}

export function summarizeChatActivity(
  rowCount: number,
  messages: Iterable<ActivityMessage>,
  items: Iterable<OrchestrationV2TurnItem>,
  representedSettlements: Iterable<string> = [],
): string {
  const counts = new Map<string, number>();
  const pullRequests = new Set<string>();
  const settledTasks = new Set(representedSettlements);
  const count = (word: string) => counts.set(word, (counts.get(word) ?? 0) + 1);
  for (const message of messages) {
    const sender = resolveMessageSender(message);
    if (sender.kind === "agent") count("agent update");
    if (sender.kind === "automation") count("automation");
    if (sender.kind === "system") count("system notice");
    for (const match of message.text.matchAll(
      /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/gi,
    )) {
      pullRequests.add(`github.com/${match[1]!.toLowerCase()}#${match[2]}`);
    }
  }
  for (const item of items) {
    for (const id of settledChatActivityTaskIds(item)) settledTasks.add(id);
    if (item.type !== "notification") continue;
    if (item.source.kind !== "system") count("agent update");
    if (item.source.kind === "monitor") {
      for (const pr of [item.source.pullRequest, ...(item.source.otherPullRequests ?? [])]) {
        if (pr) pullRequests.add(`${pr.host}/${pr.repository.toLowerCase()}#${pr.number}`);
      }
    }
  }
  const parts = Array.from(counts, ([word, total]) => `${total} ${word}${total === 1 ? "" : "s"}`);
  if (parts.length === 0) parts.push(`${rowCount} ${rowCount === 1 ? "update" : "updates"}`);
  if (pullRequests.size)
    parts.push(`${pullRequests.size} ${pullRequests.size === 1 ? "PR" : "PRs"}`);
  if (settledTasks.size) parts.push(`${settledTasks.size} settled`);
  return parts.join(" · ");
}

export function* chatActivityGroups<Row extends { readonly id: string }>(
  rows: ReadonlyArray<Row>,
  isBoundary: (row: Row) => boolean,
) {
  let anchor: Row | undefined;
  let group: Row[] = [];
  for (const row of rows) {
    if (!isBoundary(row)) {
      group.push(row);
      continue;
    }
    if (group.length) yield { id: `activity:${anchor?.id ?? group[0]!.id}`, rows: group };
    yield row;
    anchor = row;
    group = [];
  }
  if (group.length) yield { id: `activity:${anchor?.id ?? group[0]!.id}`, rows: group };
}
