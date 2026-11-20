import {
  type EnvironmentId,
  type LinkedSidebarEnvironment,
  type LinkedSidebarThread,
  type ModelSelection,
  OrchestrationV2ThreadShell,
  type Project,
  type ProjectId,
  type ProjectScript,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
  presentThreadShell,
} from "./models.ts";

const decodeShell = Schema.decodeUnknownSync(OrchestrationV2ThreadShell);

const utc = (value: string) => {
  const parsed = DateTime.make(value);
  if (Option.isNone(parsed)) throw new Error("bad date");
  return parsed.value;
};
const utcOrNull = (value: string | null) => (value === null ? null : utc(value));

const ACTIVE_STATUS = new Set(["preparing", "starting", "running", "waiting"]);

function threadShellFromLinkedThread(
  environmentId: EnvironmentId,
  thread: LinkedSidebarThread,
): EnvironmentThreadShell | null {
  if (thread.relationshipToParent === "subagent") return null;
  const active = ACTIVE_STATUS.has(thread.status);
  try {
    const shell = decodeShell({
      ...(thread.inbox === undefined ? {} : { inbox: thread.inbox }),
      createdBy: thread.createdBy,
      creationSource: thread.creationSource,
      id: thread.threadId,
      projectId: thread.projectId,
      title: thread.title,
      providerInstanceId: thread.providerInstanceId,
      modelSelection: { instanceId: thread.providerInstanceId, model: thread.model },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      branch: null,
      worktreePath: null,
      lineage: {
        parentThreadId: thread.parentThreadId,
        relationshipToParent: thread.relationshipToParent,
        rootThreadId: thread.parentThreadId ?? thread.threadId,
      },
      forkedFrom: null,
      activeProviderThreadId: null,
      latestRunId: thread.latestRunId,
      activeRunId: active ? thread.latestRunId : null,
      ...(active ? { activityRunStatus: thread.status } : {}),
      status: thread.status,
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: utc(thread.updatedAt),
      hasActionableProposedPlan: false,
      pendingBackgroundTasks: [],
      providerInstanceHistory: [],
      itemCount: thread.itemCount,
      visibleItemCount: thread.itemCount,
      createdAt: utc(thread.createdAt),
      updatedAt: utc(thread.updatedAt),
      archivedAt: null,
      settledOverride: thread.settled ? "settled" : null,
      settledAt: utcOrNull(thread.settledAt),
      snoozedUntil: thread.snoozed ? utcOrNull(thread.snoozedUntil) : null,
      pinnedAt: thread.pinned === true ? utc(thread.updatedAt) : null,
      deletedAt: null,
    });
    return presentThreadShell(environmentId, shell);
  } catch {
    return null;
  }
}

interface SidebarProjectInput {
  readonly id: ProjectId;
  readonly title: string;
  readonly hasCustomTitle?: boolean | undefined;
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: Project["repositoryIdentity"] | undefined;
  readonly defaultModelSelection: ModelSelection | null;
  readonly defaultThreadEnvMode?: Project["defaultThreadEnvMode"] | undefined;
  readonly autoPull?: boolean | undefined;
  readonly faviconPath?: Project["faviconPath"] | undefined;
  readonly projectIcon?: Project["projectIcon"] | undefined;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly pinnedAt?: string | null | undefined;
  readonly archivedAt?: string | null | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

const projectShell = (
  environmentId: EnvironmentId,
  project: SidebarProjectInput,
): EnvironmentProject | null =>
  project.deletedAt !== null
    ? null
    : {
        id: project.id,
        title: project.title,
        ...(project.hasCustomTitle === undefined ? {} : { hasCustomTitle: project.hasCustomTitle }),
        workspaceRoot: project.workspaceRoot,
        ...(project.repositoryIdentity === undefined
          ? {}
          : { repositoryIdentity: project.repositoryIdentity }),
        defaultModelSelection: project.defaultModelSelection,
        ...(project.defaultThreadEnvMode === undefined
          ? {}
          : { defaultThreadEnvMode: project.defaultThreadEnvMode }),
        ...(project.autoPull === undefined ? {} : { autoPull: project.autoPull }),
        ...(project.faviconPath === undefined ? {} : { faviconPath: project.faviconPath }),
        ...(project.projectIcon === undefined ? {} : { projectIcon: project.projectIcon }),
        scripts: project.scripts,
        ...(project.pinnedAt === undefined ? {} : { pinnedAt: project.pinnedAt }),
        ...(project.archivedAt === undefined ? {} : { archivedAt: project.archivedAt }),
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        environmentId,
      };

export function sidebarFromServerLinks(input: {
  readonly catalogEnvironmentIds: ReadonlySet<EnvironmentId> | ReadonlyArray<EnvironmentId>;
  readonly environments: ReadonlyArray<LinkedSidebarEnvironment>;
}): {
  readonly identities: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
} {
  const catalog = new Set(input.catalogEnvironmentIds);
  const identities: Array<{ readonly environmentId: EnvironmentId; readonly label: string }> = [];
  const projects: Array<EnvironmentProject> = [];
  const threads: Array<EnvironmentThreadShell> = [];
  const seenProjects = new Set<string>();
  const seenEnvironments = new Set<EnvironmentId>();
  const seenThreads = new Set<string>();
  for (const environment of input.environments) {
    if (catalog.has(environment.environmentId)) continue;
    if (!seenEnvironments.has(environment.environmentId)) {
      seenEnvironments.add(environment.environmentId);
      identities.push({ environmentId: environment.environmentId, label: environment.label });
    }
    for (const project of environment.projects) {
      const projectKey = `${environment.environmentId}\0${project.id}`;
      if (seenProjects.has(projectKey)) continue;
      const shell = projectShell(environment.environmentId, project);
      if (shell === null) continue;
      projects.push(shell);
      seenProjects.add(projectKey);
    }
    for (const thread of environment.threads) {
      const threadKey = `${environment.environmentId}\0${thread.threadId}`;
      if (seenThreads.has(threadKey)) continue;
      const shell = threadShellFromLinkedThread(environment.environmentId, thread);
      if (shell === null) continue;
      seenThreads.add(threadKey);
      threads.push(shell);
      const key = `${environment.environmentId}\0${thread.projectId}`;
      if (seenProjects.has(key)) continue;
      seenProjects.add(key);
      projects.push(
        projectShell(environment.environmentId, {
          id: thread.projectId,
          title: "Untitled project",
          workspaceRoot: ".",
          defaultModelSelection: null,
          scripts: [],
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          deletedAt: null,
        })!,
      );
    }
  }
  return { identities, projects, threads };
}
