import {
  agentInboxRoutingError,
  CommandId,
  makeThreadInbox,
  OrchestratorMcpFailure,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type ThreadMetadataMcpAction,
  type ThreadMetadataMcpUpdateInput,
  type ThreadMetadataMcpUpdateResult,
  ThreadId,
  redirectLinkError,
  routeThreadInbox,
  withLegacyPeerInboxReason,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  clientModeCeiling,
  isLegacyInboxPeer,
  type McpInvocationScope,
} from "./McpInvocationContext.ts";
import { threadNotFound } from "./threadAccess.ts";

export class ThreadMetadataMcpService extends Context.Service<
  ThreadMetadataMcpService,
  {
    readonly update: (
      scope: McpInvocationScope,
      input: ThreadMetadataMcpUpdateInput,
    ) => Effect.Effect<ThreadMetadataMcpUpdateResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/ThreadMetadataMcpService") {}

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function commandId(input: {
  readonly scope: McpInvocationScope;
  readonly threadId: ThreadId;
  readonly action: ThreadMetadataMcpAction;
  readonly requestKey: string;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      stablePart(input.scope.requestNamespace),
      "thread-update",
      stablePart(input.threadId),
      stablePart(input.action),
      stablePart(input.requestKey),
    ].join(":"),
  );
}

function metadataCommand(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly update: ThreadMetadataMcpUpdateInput;
  readonly actorThreadId: ThreadId | undefined;
}): Extract<
  OrchestrationV2Command,
  {
    readonly type: "thread.metadata.update" | "thread.standing.set" | "thread.delegation-nudge.set";
  }
> {
  switch (input.update.action) {
    case "set_standing":
      return {
        type: "thread.standing.set",
        commandId: input.commandId,
        threadId: input.threadId,
        standing: input.update.standing ?? null,
      };
    case "set_delegation_nudge":
      return {
        type: "thread.delegation-nudge.set",
        commandId: input.commandId,
        threadId: input.threadId,
        enabled: input.update.delegationNudge?.enabled ?? false,
        ...(input.update.delegationNudge?.thresholds === undefined
          ? {}
          : { thresholds: input.update.delegationNudge.thresholds }),
        changedBy:
          input.actorThreadId === undefined
            ? { kind: "mcp_client" }
            : { kind: "agent", threadId: input.actorThreadId },
      };
    case "set_redirect":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        replacedByThreadId: input.update.replacedByThreadId ?? null,
      };
    case "route":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        inboxRouting: input.update.inboxRouting!,
      };
    case "rename":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        title: input.update.title!,
      };
    case "regenerate_title":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        regenerateTitle: true,
      };
    case "request_decision":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        decisionRequest: input.update.decision!,
      };
    case "resolve_decision":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        decisionRequest: null,
      };
  }
}

function resultFromThread(input: {
  readonly action: ThreadMetadataMcpAction;
  readonly commandId: CommandId;
  readonly sequence: number;
  readonly thread: Pick<
    OrchestrationV2AppThread,
    | "id"
    | "title"
    | "titleRegeneration"
    | "linkedPullRequest"
    | "updatedAt"
    | "inbox"
    | "standing"
    | "delegationNudge"
    | "replacedByThreadId"
    | "retiredAt"
  >;
}): ThreadMetadataMcpUpdateResult {
  return {
    ...(input.thread.inbox === undefined ? {} : { inbox: input.thread.inbox }),
    ...(input.thread.standing === undefined ? {} : { standing: input.thread.standing }),
    ...(input.thread.delegationNudge === undefined
      ? {}
      : { delegationNudge: input.thread.delegationNudge }),
    ...(input.thread.replacedByThreadId === undefined
      ? {}
      : {
          replacedByThreadId: input.thread.replacedByThreadId,
          retiredAt:
            input.thread.retiredAt == null ? null : DateTime.formatIso(input.thread.retiredAt),
        }),
    threadId: input.thread.id,
    action: input.action,
    commandId: input.commandId,
    sequence: input.sequence,
    title: input.thread.title,
    titleRegeneration:
      input.thread.titleRegeneration === undefined || input.thread.titleRegeneration === null
        ? null
        : {
            requestId: input.thread.titleRegeneration.requestId,
            startedAt: DateTime.formatIso(input.thread.titleRegeneration.startedAt),
          },
    linkedPullRequest: input.thread.linkedPullRequest ?? null,
    updatedAt: DateTime.formatIso(input.thread.updatedAt),
  };
}

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;

  const update = Effect.fn("ThreadMetadataMcpService.update")(function* (
    scope: McpInvocationScope,
    requested: ThreadMetadataMcpUpdateInput,
  ) {
    // An older linked environment cannot send a reason; file its route as FYI, not a dead end.
    const input = withLegacyPeerInboxReason(requested, isLegacyInboxPeer(scope));
    if (!scope.capabilities.has("orchestration")) {
      return yield* failure(
        "capability_denied",
        "This MCP credential does not grant orchestration capabilities.",
      );
    }

    const threadId = input.threadId ?? scope.thread?.threadId;
    if (threadId === undefined) {
      return yield* failure(
        "target_required",
        "Pass threadId: this MCP client is not running inside a T3 thread.",
      );
    }
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to locate thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );
    if (shell === null || shell.deletedAt !== null) {
      return yield* threadNotFound(
        threadManagement,
        scope,
        threadId,
        `Thread ${threadId} was not found.`,
      );
    }
    const inboxError =
      input.inboxRouting === undefined
        ? null
        : agentInboxRoutingError(
            routeThreadInbox(shell.inbox ?? makeThreadInbox({ actor: null }), input.inboxRouting),
            input.inboxRouting,
          );
    if (inboxError !== null) return yield* failure("invalid_request", inboxError);
    if (input.action === "set_delegation_nudge" && scope.thread?.threadId === threadId) {
      return yield* failure(
        "invalid_request",
        "A thread cannot change its own delegation nudge. Ask from another thread or the client.",
      );
    }
    if (input.action === "set_redirect") {
      // A redirect moves every wake aimed at a thread onto another one, so it is an admin act:
      // only a full-access, default-mode caller (thread or client) may set or clear it. A narrower
      // caller could otherwise hijack a thread's wakes or point them at a wider-mode thread.
      const callerShell =
        scope.thread === undefined
          ? null
          : yield* threadManagement
              .getThreadShell(scope.thread.threadId)
              .pipe(Effect.orElseSucceed(() => null));
      const modes =
        scope.thread === undefined
          ? [clientModeCeiling(scope.client)]
          : callerShell === null
            ? []
            : [
                callerShell,
                // A linked client's approval narrows the thread it speaks for.
                ...(scope.client === undefined ? [] : [clientModeCeiling(scope.client)]),
              ];
      if (
        modes.length === 0 ||
        modes.some(
          (mode) => mode.runtimeMode !== "full-access" || mode.interactionMode !== "default",
        )
      ) {
        return yield* failure(
          "capability_denied",
          "Setting or clearing a thread redirect needs a full-access caller in default mode.",
        );
      }
    }
    if (input.action === "set_redirect" && input.replacedByThreadId != null) {
      // Same check the orchestrator repeats at commit; failing here gives the caller a clear reason.
      const linkError = yield* redirectLinkError(
        (id) => threadManagement.getThreadShell(id),
        threadId,
        input.replacedByThreadId,
      ).pipe(Effect.mapError((error) => failure("orchestration_error", errorMessage(error))));
      if (linkError !== null) return yield* failure("invalid_request", linkError);
    }
    const requestKey =
      input.clientRequestId === undefined ? yield* random.uuidV4() : input.clientRequestId;
    const updateCommandId = commandId({
      scope,
      threadId,
      action: input.action,
      requestKey,
    });
    const dispatched = yield* threadManagement
      .dispatch(
        metadataCommand({
          commandId: updateCommandId,
          threadId,
          update: input,
          actorThreadId: scope.thread?.threadId,
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to ${input.action} for thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );
    const metadataEvent = dispatched.storedEvents.find(
      (stored) =>
        stored.event.type === "thread.metadata-updated" ||
        stored.event.type === "thread.standing-updated" ||
        stored.event.type === "thread.delegation-nudge-updated",
    );
    // Retries may find stored events compacted away; answer from the projection.
    const thread =
      metadataEvent?.event.type === "thread.metadata-updated" ||
      metadataEvent?.event.type === "thread.standing-updated" ||
      metadataEvent?.event.type === "thread.delegation-nudge-updated"
        ? metadataEvent.event.payload
        : yield* threadManagement
            .getThreadShell(threadId)
            .pipe(Effect.mapError((error) => failure("orchestration_error", errorMessage(error))));
    if (thread === null) {
      return yield* failure(
        "orchestration_error",
        `Thread ${threadId} metadata update completed without a resultant state.`,
      );
    }
    return resultFromThread({
      action: input.action,
      commandId: updateCommandId,
      sequence: dispatched.sequence,
      thread,
    });
  });

  return ThreadMetadataMcpService.of({ update });
});

export const layer: Layer.Layer<
  ThreadMetadataMcpService,
  never,
  SecureRandom.SecureRandom | ThreadManagementService.ThreadManagementService
> = Layer.effect(ThreadMetadataMcpService, make);
