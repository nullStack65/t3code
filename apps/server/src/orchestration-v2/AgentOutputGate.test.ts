import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  evaluateAgentOutputGate,
  isExplicitChannelToolName,
  OUTPUT_GATE_BOUNCE_PROMPT,
  outputGateBounceCommandId,
  outputGateBounceMessageId,
} from "./AgentOutputGate.ts";
import * as AgentOutputGateReactor from "./AgentOutputGateReactor.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const now = DateTime.makeUnsafe("2026-11-26T00:00:00.000Z");
const threadId = ThreadId.make("thread:output-gate");
const runId = RunId.make("run:output-gate-1");
const bounceRunId = RunId.make("run:output-gate-2");
const userMsgId = MessageId.make("msg:user-1");
const agentMsgId = MessageId.make("msg:agent-1");

const baseThread = (
  overrides: Partial<Pick<OrchestrationV2AppThread, "deletedAt" | "archivedAt" | "lineage">> = {},
): Pick<OrchestrationV2AppThread, "deletedAt" | "archivedAt" | "lineage"> => ({
  deletedAt: null,
  archivedAt: null,
  lineage: {
    rootThreadId: threadId,
    parentThreadId: null,
    relationshipToParent: null,
  },
  ...overrides,
});

const baseRun = (
  overrides: Partial<Pick<OrchestrationV2Run, "id" | "status" | "userMessageId">> = {},
): Pick<OrchestrationV2Run, "id" | "status" | "userMessageId"> => ({
  id: runId,
  status: "completed",
  userMessageId: agentMsgId,
  ...overrides,
});

const assistantItem = (
  id: string,
  text: string,
  targetRunId: RunId = runId,
): Extract<OrchestrationV2TurnItem, { readonly type: "assistant_message" }> => ({
  type: "assistant_message",
  id: TurnItemId.make(id),
  threadId,
  runId: targetRunId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  messageId: MessageId.make(`m:${id}`),
  text,
  streaming: false,
});

const toolItem = (
  id: string,
  toolName: string,
  status: OrchestrationV2TurnItem["status"] = "completed",
  targetRunId: RunId = runId,
): Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }> => ({
  type: "dynamic_tool",
  id: TurnItemId.make(id),
  threadId,
  runId: targetRunId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  toolName,
  input: {},
  output: {},
});

const userMessage = (
  createdBy: "user" | "agent",
  extra: Partial<OrchestrationV2ConversationMessage> = {},
): Pick<
  OrchestrationV2ConversationMessage,
  | "createdBy"
  | "creationSource"
  | "notification"
  | "scheduledTaskId"
  | "senderThreadId"
  | "linkedSender"
> => ({
  createdBy,
  creationSource: createdBy === "user" ? "web" : "mcp",
  ...extra,
});

describe("AgentOutputGate policy", () => {
  it("recognizes explicit channel tools across raw and provider-prefixed names", () => {
    assert.isTrue(isExplicitChannelToolName("send_to_user"));
    assert.isTrue(isExplicitChannelToolName("mcp__t3-code__send_to_user"));
    assert.isTrue(isExplicitChannelToolName("silent_ack"));
    assert.isTrue(isExplicitChannelToolName("mcp__t3-code__silent_ack"));
    assert.isTrue(isExplicitChannelToolName("t3_thread_send"));
    assert.isTrue(isExplicitChannelToolName("mcp__t3-code__t3_thread_send"));
    assert.isTrue(isExplicitChannelToolName("ask_agent"));
    assert.isTrue(isExplicitChannelToolName("mcp__t3-code__ask_agent"));
    assert.isFalse(isExplicitChannelToolName("t3_thread_read"));
    assert.isFalse(isExplicitChannelToolName(null));
  });

  it("never gates or bounces origin='user' turns", () => {
    const decision = evaluateAgentOutputGate({
      thread: baseThread(),
      run: baseRun({ userMessageId: userMsgId }),
      userMessage: userMessage("user"),
      turnItems: [assistantItem("a1", "Here is my reply to the founder.")],
    });
    assert.deepEqual(decision, { action: "allow", reason: "user_origin" });
  });

  it("never gates sideChat (ask_agent) or subagent threads", () => {
    const side = evaluateAgentOutputGate({
      thread: baseThread({
        lineage: {
          rootThreadId: threadId,
          parentThreadId: ThreadId.make("thread:parent"),
          relationshipToParent: "fork",
          sideChat: true,
        },
      }),
      run: baseRun(),
      userMessage: userMessage("agent"),
      turnItems: [assistantItem("a1", "Direct answer for ask_agent.")],
    });
    assert.deepEqual(side, { action: "allow", reason: "side_chat" });

    const subagent = evaluateAgentOutputGate({
      thread: baseThread({
        lineage: {
          rootThreadId: threadId,
          parentThreadId: ThreadId.make("thread:parent"),
          relationshipToParent: "subagent",
        },
      }),
      run: baseRun(),
      userMessage: userMessage("agent"),
      turnItems: [assistantItem("a1", "Child task summary.")],
    });
    assert.deepEqual(subagent, { action: "allow", reason: "subagent_thread" });
  });

  it("allows agent-originated turns that already used an explicit channel tool", () => {
    for (const toolName of [
      "mcp__t3-code__send_to_user",
      "mcp__t3-code__t3_thread_send",
      "mcp__t3-code__ask_agent",
      "mcp__t3-code__silent_ack",
    ]) {
      const decision = evaluateAgentOutputGate({
        thread: baseThread(),
        run: baseRun(),
        userMessage: userMessage("agent"),
        turnItems: [toolItem("t1", toolName), assistantItem("a1", "Done.")],
      });
      assert.deepEqual(decision, { action: "allow", reason: "explicit_channel" });
    }
  });

  it("bounces once on unrouted plain text in an agent-originated wake", () => {
    const decision = evaluateAgentOutputGate({
      thread: baseThread(),
      run: baseRun(),
      userMessage: userMessage("agent"),
      turnItems: [assistantItem("a1", "I think Kameron should pick option B.")],
    });
    assert.deepEqual(decision, { action: "bounce", prompt: OUTPUT_GATE_BOUNCE_PROMPT });
  });

  it("fails open into agent_fold on a bounce run that still ends unrouted (never loops >1)", () => {
    const decision = evaluateAgentOutputGate({
      thread: baseThread(),
      run: baseRun({ id: bounceRunId, userMessageId: outputGateBounceMessageId(runId) }),
      userMessage: userMessage("agent"),
      turnItems: [assistantItem("a2", "Still plain text.", bounceRunId)],
    });
    assert.deepEqual(decision, { action: "fail_open_fold", reason: "bounce_exhausted" });
  });
});

describe("AgentOutputGateReactor", () => {
  it.effect(
    "dispatches 1 bounce on unrouted agent wake and fails open to agent_fold on second pass",
    () =>
      Effect.gen(function* () {
        const dispatched = yield* Ref.make<Array<OrchestrationV2ServerCommand>>([]);
        const writtenEvents = yield* Ref.make<Array<OrchestrationV2DomainEvent>>([]);
        let nextEventSeq = 1;

        const makeRecords = (targetRunId: RunId) => {
          const isBounce = targetRunId === bounceRunId;
          const msgId = isBounce ? outputGateBounceMessageId(runId) : agentMsgId;
          return {
            thread: {
              ...baseThread(),
              id: threadId,
              projectId: ProjectId.make("project:gate"),
              providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            },
            runs: [
              {
                ...baseRun({ id: targetRunId, userMessageId: msgId }),
                providerInstanceId: ProviderInstanceId.make("claudeAgent"),
              },
            ],
            messages: [
              {
                id: msgId,
                threadId,
                runId: targetRunId,
                role: "user",
                text: isBounce ? OUTPUT_GATE_BOUNCE_PROMPT : "Agent wake",
                ...userMessage("agent"),
              },
            ],
            turnItems: [assistantItem(isBounce ? "a2" : "a1", "Unrouted plain text", targetRunId)],
          };
        };

        const layer = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.empty,
            dispatch: (command) =>
              Ref.update(dispatched, (list) => [...list, command]).pipe(
                Effect.as({ sequence: 1, storedEvents: [] } as never),
              ),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords: (_id, _fields, filter) =>
              Effect.succeed(makeRecords(filter?.runIds?.[0] ?? runId) as never),
            getMessagesById: () => Effect.succeed(new Map()),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: ({ events }) =>
              Ref.update(writtenEvents, (list) => [...list, ...events]).pipe(
                Effect.as([] as never),
              ),
          }),
          Layer.mock(IdAllocator.IdAllocatorV2)({
            allocate: {
              event: () => Effect.sync(() => EventId.make(`evt:${nextEventSeq++}`)),
            } as never,
            derive: {} as never,
          }),
        );

        yield* Effect.gen(function* () {
          const reactor = yield* AgentOutputGateReactor.make;
          // Pass 1: unrouted agent wake -> dispatches exactly 1 bounce.
          yield* reactor.evaluateCompletedRun({ threadId, runId });
          const cmdsAfterFirst = yield* Ref.get(dispatched);
          assert.equal(cmdsAfterFirst.length, 1);
          assert.equal(cmdsAfterFirst[0]!.type, "message.dispatch");
          if (cmdsAfterFirst[0]!.type === "message.dispatch") {
            assert.equal(cmdsAfterFirst[0]!.commandId, outputGateBounceCommandId(runId));
            assert.equal(cmdsAfterFirst[0]!.messageId, outputGateBounceMessageId(runId));
            assert.equal(cmdsAfterFirst[0]!.createdBy, "agent");
          }

          // Pass 2: bounce run still ends with plain text -> fails open into agent_fold, 0 new bounces.
          yield* reactor.evaluateCompletedRun({ threadId, runId: bounceRunId });
          const cmdsAfterSecond = yield* Ref.get(dispatched);
          assert.equal(cmdsAfterSecond.length, 1);

          const written = yield* Ref.get(writtenEvents);
          assert.equal(written.length, 1);
          assert.equal(written[0]!.type, "turn-item.updated");
          if (written[0]!.type === "turn-item.updated") {
            assert.equal(written[0]!.payload.timelineVisibility, "agent_fold");
          }
        }).pipe(Effect.provide(layer));
      }),
  );
});
