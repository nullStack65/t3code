import {
  primaryInbox,
  resolveThreadSenders,
  type OrchestrationV2OlderSettledCount,
  type OrchestrationV2OlderSettledGroup,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadInbox,
} from "@t3tools/contracts";

/** What counting reads from a thread, from its shell or the store's index. */
export type OlderSettledCountRow = Pick<OrchestrationV2ThreadShell, "id" | "projectId"> & {
  readonly inbox?: ThreadInbox | undefined;
  readonly createdBy?: string | undefined;
  readonly parentFounder?: OrchestrationV2ThreadShell["parentFounder"] | undefined;
};

/**
 * Per project, the older settled rows grouped by what an inbox filter reads. Each row's sender
 * uses its stamped `parentFounder`, so no other row is needed.
 */
export function countOlderSettledThreads(
  older: ReadonlyArray<OlderSettledCountRow>,
): ReadonlyArray<OrchestrationV2OlderSettledCount> {
  if (older.length === 0) return [];
  const senders = resolveThreadSenders(
    older.map((row) => ({
      key: row.id,
      parentKey: null,
      inbox: row.inbox,
      createdBy: row.createdBy,
      parentFounder: row.parentFounder,
    })),
  );
  const byProject = new Map<
    ProjectId,
    { count: number; groups: Map<string, OrchestrationV2OlderSettledGroup> }
  >();
  for (const row of older) {
    const sender = senders.get(row.id)!;
    const group = {
      inbox: primaryInbox(row.inbox),
      agentCreated: row.createdBy === "agent",
      founder: sender.founder,
      byAgent: sender.byAgent,
    };
    const key = `${group.inbox}|${group.agentCreated}|${group.founder}|${group.byAgent}`;
    const project = byProject.get(row.projectId) ?? { count: 0, groups: new Map() };
    byProject.set(row.projectId, project);
    project.count += 1;
    project.groups.set(key, { ...group, count: (project.groups.get(key)?.count ?? 0) + 1 });
  }
  return Array.from(byProject, ([projectId, { count, groups }]) => ({
    projectId,
    count,
    groups: [...groups.values()],
  }));
}
