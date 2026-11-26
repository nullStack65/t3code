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
  const decisionRuns = new Set<RunId>();
  const attentionByRun = new Map<RunId, Set<string>>();
  const addAttention = (runId: RunId, id: string) => {
    const ids = attentionByRun.get(runId);
    if (ids) ids.add(id);
    else attentionByRun.set(runId, new Set([id]));
  };
  let firstReplyAfterDecision: RunId | undefined;
  let latestReplyRun: RunId | undefined;
  let pendingDecision: { runId: RunId; startedAt: string } | undefined;
  for (const { createdAt, runId, message, item } of entries) {
    if (!runId) continue;
    if (message?.role === "user" && !message.humanNote) {
      const sender = resolveMessageSender(message);
      if (
        sender.kind === "agent" ||
        (includeOtherActivity && sender.kind !== "person" && sender.kind !== "guest")
      ) {
        agentRuns.add(runId);
      } else {
        directRuns.add(runId);
      }
    }
    if (item?.type === "notification") agentRuns.add(runId);
    if (item && activityItemNeedsAttention(item)) addAttention(runId, item.id);
    if (isDecisionRequestItem(item)) {
      decisionRuns.add(runId);
      const startedAt = item.startedAt === null ? createdAt : DateTime.formatIso(item.startedAt);
      if (
        decisionRequestedAt &&
        startedAt <= decisionRequestedAt &&
        (pendingDecision === undefined || startedAt >= pendingDecision.startedAt)
      ) {
        pendingDecision = { runId, startedAt };
      }
    }
    if (message?.role === "assistant" && !message.humanNote) latestReplyRun = runId;
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
  if (keepLatestReply && latestReplyRun !== undefined) decisionRuns.add(latestReplyRun);
  for (const run of runs) {
    if (run.status === "failed") addAttention(run.id, run.id);
  }
  return { agentRuns, decisionRuns, attentionByRun, includeOtherActivity };
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
