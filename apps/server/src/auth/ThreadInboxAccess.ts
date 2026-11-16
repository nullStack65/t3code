import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import {
  canReadInbox,
  canRouteInbox,
  inboxIdentityFromSubject,
  EnvironmentAuthorizationError,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ClientOrchestrationCommand,
  type ThreadId,
  type ThreadInbox,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export function threadInboxAccess(
  subject: string,
  query: Pick<ProjectionSnapshotQueryShape, "getThreadShellById">,
) {
  const identity = inboxIdentityFromSubject(subject);
  const denied = (write = false) =>
    new EnvironmentAuthorizationError({
      message: "This session is not authorized for this thread or host operation.",
      requiredScope: write ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
    });
  const canRead = (inbox: ThreadInbox | null | undefined) =>
    identity === null || canReadInbox(identity, inbox);
  const requireThread = (threadId: ThreadId, write = false) =>
    Effect.gen(function* () {
      if (identity === null) return;
      const thread = yield* query.getThreadShellById(threadId);
      if (Option.isNone(thread) || !canRead(thread.value.inbox)) return yield* denied(write);
    });
  const filterSnapshot = <
    T extends {
      readonly threads: ReadonlyArray<{
        readonly id: ThreadId;
        readonly projectId: string;
        readonly inbox?: ThreadInbox | null | undefined;
      }>;
      readonly projects: ReadonlyArray<{ readonly id: string }>;
    },
  >(
    snapshot: T,
  ): T => {
    if (identity === null) return snapshot;
    const threads = snapshot.threads.filter((thread) => canRead(thread.inbox));
    const projects = snapshot.projects.filter((project) =>
      threads.some((thread) => thread.projectId === project.id),
    );
    return { ...snapshot, threads, projects };
  };
  const prepareCommand = (
    command: ClientOrchestrationCommand,
    environmentId: EnvironmentId,
  ): Effect.Effect<
    ClientOrchestrationCommand,
    EnvironmentAuthorizationError | ProjectionRepositoryError
  > =>
    Effect.gen(function* () {
      if (identity === null) {
        // Host-level sessions have no founder provenance. Never trust supplied provenance.
        if (
          ("inbox" in command && command.inbox != null) ||
          (command.type === "thread.turn.start" && command.bootstrap?.createThread?.inbox != null)
        )
          return yield* denied(true);
        return command;
      }
      if (!("threadId" in command)) return yield* denied(true);
      // A provider process can read host files and the event database. Until a
      // separately qualified execution sandbox exists, scoped identities cannot
      // start one or change its execution context through another command.
      if (
        command.type !== "thread.create" &&
        command.type !== "thread.meta.update" &&
        command.type !== "thread.settle" &&
        command.type !== "thread.unsettle"
      )
        return yield* denied(true);
      if (
        command.type === "thread.meta.update" &&
        (command.worktreePath !== undefined ||
          command.branch !== undefined ||
          command.modelSelection !== undefined)
      )
        return yield* denied(true);
      const existing = yield* query.getThreadShellById(command.threadId);
      if (command.type === "thread.create") {
        const routing = command.inboxRouting ?? {
          assignee: identity.actor,
          audience: identity.actor.kind === "human" ? identity.actor.id : ("agent-only" as const),
          attentionKind:
            identity.actor.kind === "human" ? ("action" as const) : ("background" as const),
        };
        if (!canRouteInbox(identity, routing)) return yield* denied(true);
        const inbox: ThreadInbox = {
          ...routing,
          requestedBy: identity.actor,
          actor: identity.actor,
          executorEnvironmentId: environmentId,
        };
        return {
          ...command,
          executionScope: "coordinator" as const,
          branch: null,
          worktreePath: null,
          inbox,
        };
      }
      yield* requireThread(command.threadId, true);
      if (command.type === "thread.meta.update" && command.inboxRouting) {
        if (
          Option.isNone(existing) ||
          !existing.value.inbox ||
          !canRouteInbox(identity, command.inboxRouting)
        )
          return yield* denied(true);
      }
      return command;
    });
  return { identity, denied, canRead, requireThread, filterSnapshot, prepareCommand };
}

const inboxRpcMethods = new Set<string>([
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  ORCHESTRATION_WS_METHODS.searchThreads,
  ORCHESTRATION_WS_METHODS.subscribeShell,
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  ORCHESTRATION_WS_METHODS.subscribeThread,
  WS_METHODS.serverGetConfig,
  WS_METHODS.serverReportClientActivity,
  WS_METHODS.serverGetBackgroundPolicy,
  WS_METHODS.subscribeBackgroundPolicy,
]);
export const inboxRpcAllowed = (subject: string, method: string) =>
  inboxIdentityFromSubject(subject) === null || inboxRpcMethods.has(method);
export const inboxHttpAllowed = (subject: string, path: string) =>
  inboxIdentityFromSubject(subject) === null ||
  /^\/api\/(?:orchestration(?:\/|$)|auth\/(?:session|websocket-ticket)$)/.test(
    path.split("?")[0] ?? "",
  );
