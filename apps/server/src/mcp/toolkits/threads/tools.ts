import { ThreadId, ThreadInboxType, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

export const SetThreadRoutingInput = Schema.Struct({
  threadId: Schema.optional(
    Schema.NullOr(ThreadId).annotate({
      description: "Thread to tag. Omit to tag the calling thread.",
    }),
  ),
  owner: Schema.optional(
    Schema.NullOr(TrimmedNonEmptyString).annotate({
      description:
        "Who the thread is for. Free-form. Known values: Kameron, Jeff, Lead, Jeff's Lead. Null clears the owner.",
    }),
  ),
  threadType: Schema.optional(
    Schema.NullOr(ThreadInboxType).annotate({
      description:
        "needs-human when a person should act, fyi for context, bot-work for bot-to-bot threads. Null clears the type.",
    }),
  ),
  startedBy: Schema.optional(
    Schema.NullOr(TrimmedNonEmptyString).annotate({
      description: "Who opened the thread. Null clears it. Usually set at creation.",
    }),
  ),
});
export type SetThreadRoutingInput = typeof SetThreadRoutingInput.Type;

export const SetThreadRoutingResult = Schema.Struct({
  threadId: ThreadId,
  owner: Schema.NullOr(Schema.String),
  threadType: Schema.NullOr(ThreadInboxType),
  startedBy: Schema.NullOr(Schema.String),
});
export type SetThreadRoutingResult = typeof SetThreadRoutingResult.Type;

export class ThreadRoutingInvalidError extends Schema.TaggedError<ThreadRoutingInvalidError>()(
  "ThreadRoutingInvalidError",
  {},
) {
  override get message(): string {
    return "Pass owner, threadType, or startedBy. Omit a field to leave it unchanged; null clears it.";
  }
}

export class ThreadRoutingNotFoundError extends Schema.TaggedError<ThreadRoutingNotFoundError>()(
  "ThreadRoutingNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class ThreadRoutingFailedError extends Schema.TaggedError<ThreadRoutingFailedError>()(
  "ThreadRoutingFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not update the thread's owner or type.";
  }
}

const ThreadRoutingError = Schema.Union([
  ThreadRoutingInvalidError,
  ThreadRoutingNotFoundError,
  ThreadRoutingFailedError,
]);

const SetThreadRoutingTool = Tool.make("set_thread_routing", {
  description:
    "Tag a thread in the shared inbox. owner is who it is for (Kameron, Jeff, Lead, Jeff's Lead, or any other name). threadType is needs-human, fyi, or bot-work. startedBy is who opened it. Bot-work stays out of founder inboxes until someone shows it. Pass the same fields on thread.create and thread.turn.start bootstrap.createThread when opening a thread. Omit threadId to tag this thread. Omit a field to leave it; null clears it.",
  parameters: SetThreadRoutingInput,
  success: SetThreadRoutingResult,
  failure: ThreadRoutingError,
  dependencies,
})
  .annotate(Tool.Title, "Set thread owner and type")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadRoutingToolkit = Toolkit.make(SetThreadRoutingTool);
