import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderDriverKind,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { reportLabel } from "@t3tools/provider-core/server/notification";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const CHILD_QUESTION_REFUSAL_ANSWER = "Child threads must bring questions to their parent thread.";

function findQuestionItems(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  requestId: RuntimeRequestId,
): ReadonlyArray<OrchestrationV2UserInputQuestion> {
  const item = turnItems.findLast(
    (candidate) => candidate.type === "user_input_request" && candidate.requestId === requestId,
  );
  return item?.type === "user_input_request" ? item.questions : [];
}

function formatQuestionSummary(questions: ReadonlyArray<OrchestrationV2UserInputQuestion>): string {
  const parts = questions
    .map((entry) => {
      const prompt = entry.question.trim();
      if (prompt.length === 0) return "";
      const options = (entry.options ?? [])
        .map((option) => option.label.trim())
        .filter((label) => label.length > 0);
      return options.length > 0 ? `${prompt} (options: ${options.join(", ")})` : prompt;
    })
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? ` Question: ${parts.join(" / ")}` : "";
}

function isActiveChildQuestion(request: OrchestrationV2RuntimeRequest): boolean {
  return (
    request.status === "pending" || (request.status === "resolved" && request.decision === "cancel")
  );
}

export class DelegatedTaskQuestionReactor extends Context.Service<
  DelegatedTaskQuestionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/DelegatedTaskQuestionReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const refuseChildQuestion = Effect.fnUntraced(function* (
    childThreadId: ThreadId,
    request: OrchestrationV2RuntimeRequest,
    questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
    driver: ProviderDriverKind | undefined,
  ) {
    if (request.status !== "pending") return;
    const refusalAnswers =
      driver === "codex" || (driver === "muse" && questions.length > 0)
        ? Object.fromEntries(
            questions.map((question) => [question.id, CHILD_QUESTION_REFUSAL_ANSWER]),
          )
        : undefined;
    yield* engine.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make(
        `server:delegated-task-question-refuse:${childThreadId}:${request.id}`,
      ),
      threadId: childThreadId,
      requestId: request.id,
      decision: "cancel",
      ...(refusalAnswers === undefined ? {} : { answers: refusalAnswers }),
      createdBy: "agent",
    });
  });

  const wakeParent = Effect.fnUntraced(function* (
    task: OrchestrationV2Subagent,
    request: OrchestrationV2RuntimeRequest,
    questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
  ) {
    if (task.childThreadId === null) return;
    const key = `${task.threadId}:${request.id}`;
    const label = reportLabel(task.title?.trim() || task.prompt);
    const situation =
      request.responseCapability.type === "message"
        ? `Delegated task ${task.id} asked a question and is still working.`
        : `Delegated task ${task.id} is blocked on a question whose human-input card was refused on the child thread.`;
    const questionDetail = formatQuestionSummary(questions);
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:delegated-task-question:${key}`),
      threadId: task.threadId,
      messageId: MessageId.make(`message:delegated-task-question:${key}`),
      text: `${situation} Child question card requestId ${request.id}.${questionDetail} Subagent threads cannot ask the user directly; reply to the child with t3_thread_send on threadId ${task.childThreadId} when the answer follows from the task or the user's instructions, or ask the user from this parent thread first and then send the answer to threadId ${task.childThreadId}.`,
      notification: {
        source: { kind: "delegated_task", taskIds: [task.id], childThreadId: task.childThreadId },
        outcome: "updated",
        summary: `Delegated task${label === undefined ? "" : ` "${label}"`} has a question`,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  const cancelQueuedWakes = Effect.fnUntraced(function* (
    parentThreadId: ThreadId,
    requestIds: ReadonlyArray<RuntimeRequestId>,
  ) {
    const parent = yield* projections.getThreadRecords(parentThreadId, ["runs"]);
    for (const requestId of requestIds) {
      const key = `${parentThreadId}:${requestId}`;
      const messageId = MessageId.make(`message:delegated-task-question:${key}`);
      const queued = parent.runs.find(
        (run) => run.status === "queued" && run.userMessageId === messageId,
      );
      if (queued === undefined) continue;
      yield* engine
        .dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`server:delegated-task-question-cancel:${key}`),
          threadId: parentThreadId,
          runId: queued.id,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("cancelling a delegated task question wake failed", {
              threadId: parentThreadId,
              requestId,
              cause,
            }),
          ),
        );
    }
  });

  // Runs for every domain event; most events return before any work is needed.
  const handle: DelegatedTaskQuestionReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "run.updated") {
        if (!["completed", "failed", "waiting"].includes(event.payload.status)) return;
        const parent = yield* projections.getThreadRecords(event.threadId, ["subagents"]);
        if (parent.thread.archivedAt !== null || parent.thread.deletedAt !== null) return;
        for (const task of parent.subagents) {
          if (
            task.origin !== "app_owned" ||
            task.runId !== event.payload.id ||
            task.completionWake !== "settled_only" ||
            task.completionDelivery?.state === "disposed" ||
            task.childThreadId === null ||
            ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
          ) {
            continue;
          }
          const child = yield* projections.getThreadRecords(task.childThreadId, [
            "runtimeRequests",
            "turnItems",
            "providerSessions",
          ]);
          for (const request of child.runtimeRequests) {
            if (
              request.kind !== "user_input" ||
              !isActiveChildQuestion(request) ||
              request.responseCapability.type !== "live"
            ) {
              continue;
            }
            const questions = findQuestionItems(child.turnItems, request.id);
            const sessionId = request.responseCapability.providerSessionId;
            const driver = child.providerSessions.find(
              (session) => session.id === sessionId,
            )?.driver;
            yield* refuseChildQuestion(task.childThreadId, request, questions, driver).pipe(
              Effect.andThen(wakeParent(task, request, questions)),
              Effect.catchCause((cause) =>
                Effect.logWarning("catching up a delegated task question failed", {
                  taskId: task.id,
                  requestId: request.id,
                  cause,
                }),
              ),
            );
          }
        }
        return;
      }
      if (event.type === "subagent.updated") {
        const task = event.payload;
        if (
          task.origin !== "app_owned" ||
          task.childThreadId === null ||
          !["completed", "failed", "cancelled", "interrupted"].includes(task.status)
        ) {
          return;
        }
        // A settled task can no longer use an answer to its still-pending questions.
        const { runtimeRequests } = yield* projections.getThreadRecords(task.childThreadId, [
          "runtimeRequests",
        ]);
        const questions = runtimeRequests.filter((request) => request.kind === "user_input");
        if (questions.length === 0) return;
        const child = yield* projections.getThreadRecords(task.childThreadId, ["runs", "nodes"]);
        const taskRunIds = new Set(
          child.runs
            .filter(
              (run) =>
                run.delegatedTaskId === task.id ||
                (run.delegatedTaskId === undefined &&
                  child.thread.forkedFrom?.type === "node" &&
                  child.thread.forkedFrom.nodeId === task.id),
            )
            .map((run) => run.id),
        );
        const taskNodeIds = new Set(
          child.nodes
            .filter((node) => node.runId !== null && taskRunIds.has(node.runId))
            .map((node) => node.id),
        );
        yield* cancelQueuedWakes(
          task.threadId,
          questions
            .filter((request) => taskNodeIds.has(request.nodeId))
            .map((request) => request.id),
        );
        return;
      }
      if (event.type !== "runtime-request.updated" || event.payload.kind !== "user_input") {
        return;
      }
      const child = yield* projections.getThread(event.threadId);
      const parentThreadId = child.lineage.parentThreadId;
      if (parentThreadId === null) return;
      if (event.payload.status === "resolved" && event.payload.decision === "cancel") {
        return;
      }
      const request = yield* projections.getRuntimeRequest(event.threadId, event.payload.id);
      if (
        event.payload.status !== "pending" ||
        request === undefined ||
        !isActiveChildQuestion(request)
      ) {
        yield* cancelQueuedWakes(parentThreadId, [event.payload.id]);
        return;
      }
      const parent = yield* projections.getThreadRecords(parentThreadId, ["subagents", "runs"]);
      const childRecords = yield* projections.getThreadRecords(child.id, [
        "runs",
        "turnItems",
        "providerSessions",
      ]);
      const run =
        childRecords.runs.find((candidate) => candidate.id === event.runId) ??
        childRecords.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      const taskId =
        run?.delegatedTaskId ??
        (child.forkedFrom?.type === "node" ? child.forkedFrom.nodeId : undefined);
      const task = parent.subagents.find(
        (candidate) => candidate.origin === "app_owned" && candidate.id === taskId,
      );
      const isDelegatedChild =
        child.lineage.relationshipToParent === "subagent" || task !== undefined;
      if (!isDelegatedChild) {
        return;
      }
      const questions = findQuestionItems(childRecords.turnItems, request.id);
      const sessionId =
        request.responseCapability.type === "live"
          ? request.responseCapability.providerSessionId
          : undefined;
      const driver =
        event.driver ??
        (sessionId === undefined
          ? undefined
          : childRecords.providerSessions.find((session) => session.id === sessionId)?.driver);
      yield* refuseChildQuestion(child.id, request, questions, driver);
      if (
        task === undefined ||
        ["completed", "failed", "cancelled", "interrupted"].includes(task.status) ||
        parent.thread.archivedAt !== null ||
        parent.thread.deletedAt !== null
      ) {
        return;
      }
      // The card is refused above, so a blocking delegate_task wait no longer sees a pending
      // question; the wake is the only way the parent learns what the child asked.
      yield* wakeParent(task, request, questions);
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("waking the parent of a delegated task question failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  // Every wake and cancel goes to the parent, so keying by it keeps a question's wake ahead of
  // its task's cancel while a busy parent's lock delays only that parent's reactions.
  const parentOf = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "run.updated":
        return Effect.succeed(event.threadId);
      case "subagent.updated":
        return Effect.succeed(event.payload.threadId);
      case "runtime-request.updated":
        return event.payload.kind === "user_input"
          ? projections
              .getThread(event.threadId)
              .pipe(Effect.map((child) => child.lineage.parentThreadId))
          : Effect.succeed(null);
      default:
        return Effect.succeed(null);
    }
  };

  const start: DelegatedTaskQuestionReactor["Service"]["start"] = Effect.fn(
    "DelegatedTaskQuestionReactor.start",
  )(function* () {
    const parentReactions = yield* KeyedLock.makeRunner<ThreadId>();
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        parentOf(event).pipe(
          Effect.flatMap((parentThreadId) =>
            parentThreadId === null
              ? Effect.void
              : parentReactions.run(parentThreadId, handle(event)),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("finding the parent of a delegated task question failed", {
              threadId: event.threadId,
              cause,
            }),
          ),
        ),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task question event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, handle } satisfies DelegatedTaskQuestionReactor["Service"];
});

export const layer = Layer.effect(DelegatedTaskQuestionReactor, make);
