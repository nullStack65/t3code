import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { OrchestratorThreadAlreadyExistsError } from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const now = DateTime.makeUnsafe("2026-11-26T00:00:00.000Z");
const projectId = ProjectId.make("project:ask-agent");
const callerThreadId = ThreadId.make("thread:ask-caller");
const targetThreadId = ThreadId.make("thread:ask-target");
const replacementThreadId = ThreadId.make("thread:ask-replacement");
const sideRunId = RunId.make("run:ask-side");

const callerScope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:ask-agent"),
  requestNamespace: "provider-session:ask-agent",
  thread: {
    threadId: callerThreadId,
    providerSessionId: "provider-session:ask-agent",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const makeRun = (threadId: ThreadId, status: OrchestrationV2Run["status"]): OrchestrationV2Run =>
  ({
    id: sideRunId,
    threadId,
    status,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    createdAt: now,
    updatedAt: now,
  }) as unknown as OrchestrationV2Run;

const makeShell = (
  id: ThreadId,
  overrides: {
    readonly title?: string;
    readonly replacedByThreadId?: ThreadId | null;
  } = {},
) => ({
  ...liveThreadShell(id, { runtimeMode: "full-access" }),
  projectId,
  title: overrides.title ?? String(id),
  ...(overrides.replacedByThreadId === undefined
    ? {}
    : { replacedByThreadId: overrides.replacedByThreadId }),
});

const makeProjection = (
  id: ThreadId,
  overrides: {
    readonly title?: string;
    readonly messages?: ReadonlyArray<OrchestrationV2ConversationMessage>;
    readonly live?: boolean;
  } = {},
): OrchestrationV2ThreadProjection => {
  const base = idleThreadProjection(
    makeShell(id, overrides.title === undefined ? {} : { title: overrides.title }),
  );
  const activeRunId = overrides.live ? RunId.make(`run:live:${id}`) : null;
  return {
    ...base,
    runs:
      activeRunId === null
        ? []
        : [
            {
              id: activeRunId,
              threadId: id,
              status: "running",
              providerInstanceId: ProviderInstanceId.make("codex"),
              createdAt: now,
              updatedAt: now,
            },
          ],
    messages: overrides.messages ?? [],
  } as unknown as OrchestrationV2ThreadProjection;
};

const makeAssistantMessage = (
  id: string,
  threadId: ThreadId,
  runId: RunId,
  text: string,
): OrchestrationV2ConversationMessage =>
  ({
    id: MessageId.make(id),
    threadId,
    runId,
    role: "assistant",
    text,
    attachments: [],
    createdAt: now,
    updatedAt: now,
  }) as unknown as OrchestrationV2ConversationMessage;

const layerBase = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  ),
  Layer.provide(
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([]),
    }),
  ),
  Layer.provide(Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone })),
  Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
  Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
  Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
  Layer.provide(Layer.mock(HostResources.HostResources)({})),
);

describe("ask_agent side-channel RPC", () => {
  it.effect(
    "forks target as sideChat, returns plain assistant text, and appends an agent_fold audit notice",
    () =>
      Effect.gen(function* () {
        const dispatched = yield* Ref.make<Array<OrchestrationV2ServerCommand>>([]);
        const sentCalls = yield* Ref.make<
          Array<{ readonly threadId: ThreadId; readonly text: string }>
        >([]);

        const callerProjection = makeProjection(callerThreadId, {
          title: "Product Designer",
          live: true,
        });
        const targetProjection = makeProjection(targetThreadId, { title: "CoS" });

        const layer = layerBase.pipe(
          Layer.provide(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (id) =>
                Effect.succeed(
                  makeShell(id, {
                    title: id === callerThreadId ? "Product Designer" : "CoS",
                  }),
                ),
              getThreadRecords: (id) => {
                if (id === callerThreadId) return Effect.succeed(callerProjection);
                if (id === targetThreadId) return Effect.succeed(targetProjection);
                return Effect.succeed(
                  makeProjection(id, {
                    title: "Side-channel question",
                    messages: [
                      makeAssistantMessage(
                        "msg:1",
                        id,
                        sideRunId,
                        "Yes, Kameron approved option B.",
                      ),
                      makeAssistantMessage("msg:2", id, sideRunId, "Ship it today."),
                    ],
                  }),
                );
              },
              getProjectThreadRecords: ({ threadId: id }) =>
                Effect.succeed(id === callerThreadId ? callerProjection : targetProjection),
              dispatch: (command) =>
                Ref.update(dispatched, (list) => [...list, command]).pipe(
                  Effect.as({ sequence: 1, storedEvents: [] } as never),
                ),
              sendToThread: (input) =>
                Ref.update(sentCalls, (list) => [
                  ...list,
                  { threadId: input.threadId, text: input.text },
                ]).pipe(
                  Effect.as({
                    run: makeRun(input.threadId, "running"),
                    delivery: "started" as const,
                  } as never),
                ),
              waitForThread: (input) =>
                Effect.succeed({
                  run: makeRun(input.threadId, "completed"),
                  timedOut: false,
                } as never),
            }),
          ),
        );

        const result = yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.askAgent(callerScope, {
            threadId: targetThreadId,
            prompt: "Did Kameron approve option B?",
            clientRequestId: "ask-1",
          });
        }).pipe(Effect.provide(layer));

        assert.equal(result.threadId, targetThreadId);
        assert.equal(result.status, "completed");
        assert.equal(result.timedOut, false);
        assert.equal(result.answer, "Yes, Kameron approved option B.\n\nShip it today.");
        assert.notEqual(result.sideThreadId, targetThreadId);

        const commands = yield* Ref.get(dispatched);
        const fork = commands.find((c) => c.type === "thread.fork");
        assert.isDefined(fork);
        if (fork?.type === "thread.fork") {
          assert.equal(fork.sourceThreadId, targetThreadId);
          assert.equal(fork.targetThreadId, result.sideThreadId);
          assert.equal(fork.sideChat, true);
          assert.deepEqual(fork.sourcePoint, { type: "latest_stable" });
        }

        // Side-channel fork is restricted to read-only plan + approval-required before sending.
        const interactionModeCmd = commands.find((c) => c.type === "thread.interaction-mode.set");
        assert.isDefined(interactionModeCmd);
        if (interactionModeCmd?.type === "thread.interaction-mode.set") {
          assert.equal(interactionModeCmd.threadId, result.sideThreadId);
          assert.equal(interactionModeCmd.interactionMode, "plan");
        }
        const runtimeModeCmd = commands.find((c) => c.type === "thread.runtime-mode.set");
        assert.isDefined(runtimeModeCmd);
        if (runtimeModeCmd?.type === "thread.runtime-mode.set") {
          assert.equal(runtimeModeCmd.threadId, result.sideThreadId);
          assert.equal(runtimeModeCmd.runtimeMode, "approval-required");
        }

        // Disposable side-channel fork is deleted on completion (no stop needed when settled).
        assert.isUndefined(commands.find((c) => c.type === "thread.stop"));
        const deleteCmd = commands.find((c) => c.type === "thread.delete");
        assert.isDefined(deleteCmd);
        if (deleteCmd?.type === "thread.delete") {
          assert.equal(deleteCmd.threadId, result.sideThreadId);
        }

        // Question went ONLY to the side-channel fork, never the target main thread.
        const sends = yield* Ref.get(sentCalls);
        assert.equal(sends.length, 1);
        assert.equal(sends[0]!.threadId, result.sideThreadId);
        assert.equal(sends[0]!.text, "Did Kameron approve option B?");

        // Target main thread received a 1-line agent_fold audit notice.
        const audit = commands.find((c) => c.type === "thread.audit-notice.append");
        assert.isDefined(audit);
        if (audit?.type === "thread.audit-notice.append") {
          assert.equal(audit.threadId, targetThreadId);
          assert.equal(audit.level, "info");
          assert.equal(audit.timelineVisibility, "agent_fold");
          assert.include(audit.message, "Product Designer");
          assert.include(audit.message, "ask_agent");
        }
      }),
  );

  it.effect("returns timedOut=true and answer=null on timeout while still auditing target", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<Array<OrchestrationV2ServerCommand>>([]);
      const layer = layerBase.pipe(
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(makeShell(id)),
            getThreadRecords: (id) =>
              Effect.succeed(
                makeProjection(id, {
                  title: id === callerThreadId ? "Product Designer" : "Target",
                  live: id === callerThreadId,
                }),
              ),
            getProjectThreadRecords: ({ threadId: id }) =>
              Effect.succeed(
                makeProjection(id, {
                  title: id === callerThreadId ? "Product Designer" : "Target",
                  live: id === callerThreadId,
                }),
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (list) => [...list, command]).pipe(
                Effect.as({ sequence: 1, storedEvents: [] } as never),
              ),
            sendToThread: (input) =>
              Effect.succeed({
                run: makeRun(input.threadId, "running"),
                delivery: "started" as const,
              } as never),
            waitForThread: (input) =>
              Effect.succeed({
                run: makeRun(input.threadId, "running"),
                timedOut: true,
              } as never),
          }),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.askAgent(callerScope, {
          threadId: targetThreadId,
          prompt: "Slow question",
          timeoutMs: 500,
          clientRequestId: "ask-timeout",
        });
      }).pipe(Effect.provide(layer));

      assert.equal(result.timedOut, true);
      assert.equal(result.status, "running");
      assert.isNull(result.answer);

      const commands = yield* Ref.get(dispatched);
      const stopCmd = commands.find((c) => c.type === "thread.stop");
      assert.isDefined(stopCmd);
      if (stopCmd?.type === "thread.stop") {
        assert.equal(stopCmd.threadId, result.sideThreadId);
      }
      const deleteCmd = commands.find((c) => c.type === "thread.delete");
      assert.isDefined(deleteCmd);
      if (deleteCmd?.type === "thread.delete") {
        assert.equal(deleteCmd.threadId, result.sideThreadId);
      }
      const audit = commands.find((c) => c.type === "thread.audit-notice.append");
      assert.isDefined(audit);
      if (audit?.type === "thread.audit-notice.append") {
        assert.equal(audit.timelineVisibility, "agent_fold");
        assert.include(audit.message, "timed out");
      }
    }),
  );

  it.effect("follows retired thread redirect and reuses existing sideChat fork on retry", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<Array<OrchestrationV2ServerCommand>>([]);
      const layer = layerBase.pipe(
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(
                makeShell(id, {
                  ...(id === targetThreadId ? { replacedByThreadId: replacementThreadId } : {}),
                }),
              ),
            getThreadRecords: (id) => {
              if (id === callerThreadId || id === targetThreadId || id === replacementThreadId) {
                return Effect.succeed(
                  makeProjection(id, {
                    title: id === replacementThreadId ? "CoS v2" : "Thread",
                    live: id === callerThreadId,
                  }),
                );
              }
              return Effect.succeed(
                makeProjection(id, {
                  messages: [makeAssistantMessage("msg:r", id, sideRunId, "Redirected answer.")],
                }),
              );
            },
            getProjectThreadRecords: ({ threadId: id }) =>
              Effect.succeed(
                makeProjection(id, {
                  title: id === replacementThreadId ? "CoS v2" : "Thread",
                  live: id === callerThreadId,
                }),
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (list) => [...list, command]).pipe(
                Effect.flatMap(() =>
                  command.type === "thread.fork"
                    ? Effect.fail(
                        new OrchestratorThreadAlreadyExistsError({
                          commandId: command.commandId,
                          threadId: command.targetThreadId,
                        }) as never,
                      )
                    : Effect.succeed({ sequence: 1, storedEvents: [] } as never),
                ),
              ),
            sendToThread: (input) =>
              Effect.succeed({
                run: makeRun(input.threadId, "running"),
                delivery: "started" as const,
              } as never),
            waitForThread: (input) =>
              Effect.succeed({
                run: makeRun(input.threadId, "completed"),
                timedOut: false,
              } as never),
          }),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.askAgent(callerScope, {
          threadId: targetThreadId,
          prompt: "Who owns billing?",
          clientRequestId: "ask-retry",
        });
      }).pipe(Effect.provide(layer));

      assert.equal(result.threadId, replacementThreadId);
      assert.equal(result.answer, "Redirected answer.");

      const commands = yield* Ref.get(dispatched);
      const fork = commands.find((c) => c.type === "thread.fork");
      assert.isDefined(fork);
      if (fork?.type === "thread.fork") {
        assert.equal(fork.sourceThreadId, replacementThreadId);
      }
      const audit = commands.find((c) => c.type === "thread.audit-notice.append");
      assert.isDefined(audit);
      if (audit?.type === "thread.audit-notice.append") {
        assert.equal(audit.threadId, replacementThreadId);
        assert.equal(audit.timelineVisibility, "agent_fold");
      }
    }),
  );

  it.effect(
    "persists thread.audit-notice.append as an agent_fold system_notice without starting a run",
    () => {
      const instanceId = ProviderInstanceId.make("codex");
      const adapter = {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
        openSession: () => Effect.die("No provider process needed for audit notice"),
      } as ProviderAdapter.ProviderAdapterV2["Service"];
      const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
        { name: "ask-agent-audit" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
      );

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:create-audit-target"),
          threadId: targetThreadId,
          projectId,
          title: "CoS",
          modelSelection: { instanceId, model: "gpt-5.1-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });

        yield* orchestrator.dispatch({
          type: "thread.audit-notice.append",
          commandId: CommandId.make("cmd:audit-1"),
          threadId: targetThreadId,
          title: "Side-channel question",
          message: "Answered side-channel question from Product Designer (ask_agent)",
          level: "info",
          timelineVisibility: "agent_fold",
        });

        const projection = yield* orchestrator.getThreadProjection(targetThreadId);
        assert.equal(projection.runs.length, 0);
        assert.equal(projection.messages.length, 0);
        const notice = projection.turnItems.find((item) => item.type === "system_notice");
        assert.isDefined(notice);
        if (notice?.type === "system_notice") {
          assert.isNull(notice.runId);
          assert.equal(notice.level, "info");
          assert.equal(notice.status, "completed");
          assert.equal(notice.timelineVisibility, "agent_fold");
          assert.equal(
            notice.message,
            "Answered side-channel question from Product Designer (ask_agent)",
          );
        }
      }).pipe(Effect.provide(layerOrchestrator));
    },
  );
});
