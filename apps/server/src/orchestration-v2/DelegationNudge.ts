import {
  type OrchestrationV2TurnItem,
  type RunDelegationNudgeStats,
} from "@t3tools/contracts";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";

/**
 * Orchestrator tools coordinate work instead of doing it, so they never count
 * toward a reminder and a delegation among them resets the count.
 */
const ORCHESTRATOR_TOOLS: ReadonlySet<string> = new Set([
  "delegate_task",
  "task_status",
  "task_cancel",
  "create_threads",
  "orchestrator_capabilities",
  "schedule_task",
  "run_scheduled_task_now",
  "list_scheduled_tasks",
  "delete_scheduled_task",
]);

/** Handing work to another thread is the behavior the reminder asks for. */
const DELEGATION_TOOLS: ReadonlySet<string> = new Set([
  "delegate_task",
  "create_threads",
  "t3_thread_launch",
]);

const TOP_TOOL_LIMIT = 5;

export function countedToolName(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "dynamic_tool": {
      const id = resolveT3McpToolId(item.toolName);
      if (id !== null && (ORCHESTRATOR_TOOLS.has(id) || id.startsWith("t3_thread_"))) return null;
      return item.toolName ?? "tool";
    }
    case "command_execution":
      return "command";
    case "file_change":
      return "file_change";
    case "web_search":
      return "web_search";
    case "file_search":
      return "file_search";
    default:
      return null;
  }
}

export function isDelegation(item: OrchestrationV2TurnItem): boolean {
  if (item.type === "subagent") return true;
  if (item.type !== "dynamic_tool") return false;
  const id = resolveT3McpToolId(item.toolName);
  return id !== null && DELEGATION_TOOLS.has(id);
}

export function emptyDelegationNudgeStats(): RunDelegationNudgeStats {
  return { countedToolCalls: 0, delegations: 0, nudgesFired: 0, topTools: [] };
}

export function recordCountedTool(
  stats: RunDelegationNudgeStats,
  name: string,
): RunDelegationNudgeStats {
  const counts = new Map(stats.topTools.map((tool) => [tool.name, tool.count]));
  counts.set(name, (counts.get(name) ?? 0) + 1);
  return {
    ...stats,
    countedToolCalls: stats.countedToolCalls + 1,
    topTools: [...counts]
      .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, TOP_TOOL_LIMIT)
      .map(([toolName, count]) => ({ name: toolName, count })),
  };
}

export function delegationNudgeNote(threshold: number, firm: boolean): string {
  const opening = firm
    ? `You've now made ${threshold} tool calls on this request without delegating.`
    : `You've made ${threshold} tool calls on this request without delegating.`;
  return `${opening} If this is real work rather than a quick lookup to write a brief, hand it off with delegate_task.`;
}
