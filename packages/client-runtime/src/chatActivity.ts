import {
  mentionedFounders,
  type OrchestrationV2RunStatus,
  type OrchestrationV2TurnItem,
  type RunId,
} from "@t3tools/contracts";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import { resolveMessageSender, type MessageSenderInput } from "./messageSender.ts";

type ActivityMessage = MessageSenderInput & { readonly humanNote?: true };

export interface ChatActivityEntry {
  readonly createdAt: string;
  readonly runId: RunId | null;
  readonly message?: ActivityMessage | undefined;
  readonly item?: OrchestrationV2TurnItem | undefined;
}

export function isDecisionRequestItem(item: OrchestrationV2TurnItem | undefined): boolean {
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
  let pendingDecisionRun: RunId | undefined;
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
      if (decisionRequestedAt && createdAt <= decisionRequestedAt) pendingDecisionRun = runId;
    }
    if (decisionRequestedAt && message?.role === "assistant" && createdAt >= decisionRequestedAt) {
      firstReplyAfterDecision ??= runId;
    }
  }
  if (decisionRequestedAt) {
    const runId = firstReplyAfterDecision ?? pendingDecisionRun;
    if (runId) {
      decisionRuns.add(runId);
      addAttention(runId, decisionRequestedAt);
    }
  }
  for (const id of directRuns) agentRuns.delete(id);
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

export function summarizeChatActivity(
  rowCount: number,
  messages: Iterable<ActivityMessage>,
  items: Iterable<OrchestrationV2TurnItem>,
): string {
  const counts = new Map<string, number>();
  const pullRequests = new Set<string>();
  const settledTasks = new Set<string>();
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
    if (item.type === "subagent" && item.status === "completed") settledTasks.add(item.subagentId);
    if (item.type !== "notification") continue;
    if (item.source.kind !== "system") count("agent update");
    if (item.source.kind === "delegated_task" && item.outcome === "completed") {
      for (const id of item.source.taskIds) settledTasks.add(id);
    }
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
