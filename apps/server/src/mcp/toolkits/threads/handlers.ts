import { CommandId, type OrchestrationThreadShell, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  type SetThreadRoutingInput,
  type SetThreadRoutingResult,
  ThreadRoutingFailedError,
  ThreadRoutingInvalidError,
  ThreadRoutingNotFoundError,
  ThreadRoutingToolkit,
} from "./tools.ts";

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const commandId = (threadId: ThreadId) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:mcp-thread-routing:${threadId}:${uuid}`)),
    );

  const failRouting = <E>(cause: Cause.Cause<E>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(new ThreadRoutingFailedError({ cause }));

  return ThreadRoutingToolkit.of({
    set_thread_routing: Effect.fn("ThreadRoutingToolkit.setThreadRouting")(function* (input) {
      if (
        input.owner === undefined &&
        input.threadType === undefined &&
        input.startedBy === undefined
      ) {
        return yield* new ThreadRoutingInvalidError({});
      }
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const threadId = input.threadId ?? scope.threadId;
      const thread = yield* snapshots
        .getThreadShellById(threadId)
        .pipe(Effect.mapError((cause) => new ThreadRoutingFailedError({ cause })));
      if (Option.isNone(thread)) {
        return yield* new ThreadRoutingNotFoundError({ threadId });
      }
      yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: yield* commandId(threadId),
          threadId,
          ...(input.owner !== undefined ? { owner: input.owner } : {}),
          ...(input.threadType !== undefined ? { threadType: input.threadType } : {}),
          ...(input.startedBy !== undefined ? { startedBy: input.startedBy } : {}),
        })
        .pipe(Effect.catchCause(failRouting));
      return routingResult(thread.value, input);
    }),
  });
});

function routingResult(
  thread: OrchestrationThreadShell,
  input: SetThreadRoutingInput,
): SetThreadRoutingResult {
  return {
    threadId: input.threadId ?? thread.id,
    owner: input.owner !== undefined ? input.owner : (thread.owner ?? null),
    threadType: input.threadType !== undefined ? input.threadType : (thread.threadType ?? null),
    startedBy: input.startedBy !== undefined ? input.startedBy : (thread.startedBy ?? null),
  };
}

export const ThreadRoutingToolkitHandlersLive = ThreadRoutingToolkit.toLayer(make);
