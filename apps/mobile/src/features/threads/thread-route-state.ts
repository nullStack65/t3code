import type { QueuedThreadMessage } from "../../state/thread-outbox-model";

export type NewTaskDraftRouteParams = {
  readonly requestId?: string;
  /**
   * Set by an entry scoped to one machine (a thread's own environment or branch): the new draft is
   * pinned there from its creation. Generic project entries leave it unset.
   */
  readonly environmentSelection?: "manual";
  readonly environmentId?: string | string[];
  readonly projectId?: string | string[];
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly title?: string | string[];
  readonly cloning?: string | string[];
  readonly draftId?: string | string[];
  readonly incomingShareId?: string | string[];
};

export function isDraftThreadRoute(
  route:
    | {
        readonly name: string;
        readonly params?: object;
      }
    | undefined,
) {
  return (
    route?.name === "Thread" && Boolean((route.params as { draft?: unknown } | undefined)?.draft)
  );
}

/**
 * The route of a queued new task, from Send or reopened later. A placed one also names its
 * message: the machine it runs on is the one its origin binds, which the route follows.
 */
export function queuedTaskRouteParams(
  message: Pick<QueuedThreadMessage, "environmentId" | "threadId" | "messageId" | "placement">,
) {
  return {
    environmentId: String(message.environmentId),
    threadId: String(message.threadId),
    ...(message.placement ? { pendingMessageId: String(message.messageId) } : {}),
  };
}

export function submittedThreadParams(message: Parameters<typeof queuedTaskRouteParams>[0]) {
  return { draft: undefined, ...queuedTaskRouteParams(message) };
}

/** A new task in a thread's own environment, for its project there: pinned to that machine. */
export function threadEnvironmentDraftParams(
  project: { readonly environmentId: string; readonly id: string } | undefined,
  requestId: string,
): NewTaskDraftRouteParams {
  return project
    ? {
        requestId,
        environmentId: String(project.environmentId),
        projectId: String(project.id),
        environmentSelection: "manual",
      }
    : { requestId };
}

/** A new task on a thread's branch, on that thread's machine. */
export function threadBranchDraftParams(
  thread: {
    readonly environmentId: string;
    readonly projectId: string;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  },
  requestId: string,
): NewTaskDraftRouteParams {
  return {
    requestId,
    environmentId: String(thread.environmentId),
    projectId: String(thread.projectId),
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    environmentSelection: "manual",
  };
}

/** The machine an explicitly scoped draft route pins its new draft to, if it is one. */
export function explicitDraftRouteEntry(draft: NewTaskDraftRouteParams | undefined) {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const environmentId = first(draft?.environmentId);
  const projectId = first(draft?.projectId);
  return draft?.environmentSelection === "manual" && environmentId && projectId
    ? { environmentId, projectId }
    : undefined;
}

export function draftRouteIdentity(draft: NewTaskDraftRouteParams): string {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  return JSON.stringify([
    draft.requestId,
    first(draft.draftId),
    first(draft.environmentId),
    first(draft.projectId),
    draft.branch ?? null,
    draft.worktreePath ?? null,
    first(draft.incomingShareId),
  ]);
}
