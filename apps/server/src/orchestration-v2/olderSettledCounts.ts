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
  readonly lineage: Pick<OrchestrationV2ThreadShell["lineage"], "parentThreadId">;
  readonly inbox?: ThreadInbox | undefined;
  readonly createdBy?: string | undefined;
};

/**
 * Per project, the rows `isOlder` matches, grouped by what an inbox filter reads. `rows` holds
 * every active thread, so a sender's parent chain resolves like it does on a client holding them.
 */
export function countOlderSettledThreads<Row extends OlderSettledCountRow>(
  rows: ReadonlyArray<Row>,
  isOlder: (row: Row) => boolean,
): ReadonlyArray<OrchestrationV2OlderSettledCount> {
  const older = rows.filter(isOlder);
  if (older.length === 0) return [];
  const senders = resolveThreadSenders(
    rows.map((row) => ({
      key: row.id,
      parentKey: row.lineage.parentThreadId,
      inbox: row.inbox,
      createdBy: row.createdBy,
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
