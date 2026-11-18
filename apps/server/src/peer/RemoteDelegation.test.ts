import * as DocumentText from "../provider/DocumentText.ts";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type Project,
  type RepositoryIdentity,
  RunId,
  type HostResourcesSnapshot,
  OrchestrationV2ThreadPlacementAdmitError,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import type * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";
import * as RemoteDelegation from "./RemoteDelegation.ts";
import * as PeerLinkRequests from "./PeerLinkRequests.ts";

// The laptop's agent delegates a task to the box through a link. The box is
// its real /mcp behind real OAuth, with one thread the test finishes; the
// laptop is its real orchestrator and toolkits. The parent here wakes as it
// would for a local child.

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const boxProject = ProjectId.make("project:box");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };

type LaunchedWith = Pick<
  ThreadLaunch.ThreadLaunchInput,
  "modelSelection" | "runtimeMode" | "interactionMode"
>;

/** The thread the box launches for the task, which the test finishes. */
interface BoxThread {
  readonly launched: Ref.Ref<ThreadId | null>;
  /** The link session that launched it, as the box stamps it. */
  readonly linkOrigin: Ref.Ref<{ readonly sessionId: string; readonly label: string } | null>;
  /** The parent the launch names, so the thread there can link back to it. */
  readonly delegatedFrom: Ref.Ref<ThreadLaunch.ThreadLaunchInput["delegatedFrom"] | null>;
  /** The model and modes it was launched with. */
  readonly launchedWith: Ref.Ref<LaunchedWith | null>;
  /** The first message the thread there was launched with. */
  readonly message: Ref.Ref<string | null>;
  readonly status: Ref.Ref<OrchestrationV2Run["status"]>;
  readonly reply: Ref.Ref<string | null>;
  readonly error: Ref.Ref<string | null>;
  readonly laterError: Ref.Ref<string | null>;
  /** A later run's reply, after the task's own, as a follow-up message would leave. */
  readonly laterReply: Ref.Ref<string | null>;
  /** The reply of a run queued there behind the later one; once set, the thread settles on it. */
  readonly queuedReply: Ref.Ref<string | null>;
  /** A run there restarted, which its continuation finished with this reply. */
  readonly restart: Ref.Ref<{ readonly of: RunId; readonly reply: string } | null>;
  /** The model the provider there reported running the task's run. */
  readonly executedModel: Ref.Ref<string | null>;
  /** The run each wait asked for, in order. */
  readonly waitedFor: Ref.Ref<ReadonlyArray<RunId | undefined>>;
  /** The thread's run ends with a task of its own still running, whose result wakes it again. */
  readonly nested: Ref.Ref<boolean>;
  /** Completed once a wait there blocks on that task. */
  readonly nestedWaiting: Deferred.Deferred<void>;
  /** That task settled and the run it woke answered, with `laterReply`. */
  readonly nestedSettled: Deferred.Deferred<void>;
  /** Waiting there fails with this, as a thread deleted there does. */
  readonly gone: Ref.Ref<boolean>;
  readonly interrupted: Ref.Ref<number>;
  /** What each interrupt or stop there did, once per command id. */
  readonly stops: Ref.Ref<ReadonlyArray<"interrupt" | "thread.stop" | "delegated-tasks">>;
  /** The launch starts no run, as one recorded before its run was kept. */
  readonly runless: Ref.Ref<boolean>;
  /** Completed on the first interrupt there. */
  readonly interruptedOnce: Deferred.Deferred<void>;
  readonly finished: Deferred.Deferred<void>;
  /** Ends the later run a message sent there started, for a wait pinned to it. */
  readonly laterFinished: Deferred.Deferred<void>;
  /** While set, reading the thread there waits: completed once a read starts, released by `releaseRead`. */
  readonly holdRead: Ref.Ref<boolean>;
  readonly readStarted: Deferred.Deferred<void>;
  readonly releaseRead: Deferred.Deferred<void>;
  readonly holdFirstStop: Ref.Ref<boolean>;
  readonly stopStarted: Deferred.Deferred<void>;
  readonly releaseStop: Deferred.Deferred<void>;
  /** Messages sent to the thread there after its launch, each starting a later run. */
  readonly sent: Ref.Ref<ReadonlyArray<string>>;
  /** Runs as the launch there is answered, before the laptop hears back. */
  readonly afterLaunch: Ref.Ref<Effect.Effect<void>>;
  /** The box's load as its `orchestrator_capabilities` reports it. */
  readonly resources: Ref.Ref<HostResourcesSnapshot>;
}

const GiB = 1024 ** 3;
const loadOf = (cpuUtilization: number): HostResourcesSnapshot => ({
  sampledAt: 0,
  cpuUtilization,
  cpuCount: 8,
  availableMemoryBytes: 8 * GiB,
  totalMemoryBytes: 16 * GiB,
});

const makeBoxThread = Effect.gen(function* () {
  return {
    launched: yield* Ref.make<ThreadId | null>(null),
    linkOrigin: yield* Ref.make<{ readonly sessionId: string; readonly label: string } | null>(
      null,
    ),
    delegatedFrom: yield* Ref.make<ThreadLaunch.ThreadLaunchInput["delegatedFrom"] | null>(null),
    launchedWith: yield* Ref.make<LaunchedWith | null>(null),
    message: yield* Ref.make<string | null>(null),
    status: yield* Ref.make<OrchestrationV2Run["status"]>("running"),
    reply: yield* Ref.make<string | null>("Working…"),
    error: yield* Ref.make<string | null>(null),
    laterError: yield* Ref.make<string | null>(null),
    laterReply: yield* Ref.make<string | null>(null),
    queuedReply: yield* Ref.make<string | null>(null),
    restart: yield* Ref.make<{ readonly of: RunId; readonly reply: string } | null>(null),
    executedModel: yield* Ref.make<string | null>(null),
    waitedFor: yield* Ref.make<ReadonlyArray<RunId | undefined>>([]),
    nested: yield* Ref.make(false),
    nestedWaiting: yield* Deferred.make<void>(),
    nestedSettled: yield* Deferred.make<void>(),
    gone: yield* Ref.make(false),
    interrupted: yield* Ref.make(0),
    stops: yield* Ref.make<ReadonlyArray<"interrupt" | "thread.stop" | "delegated-tasks">>([]),
    runless: yield* Ref.make(false),
    interruptedOnce: yield* Deferred.make<void>(),
    finished: yield* Deferred.make<void>(),
    laterFinished: yield* Deferred.make<void>(),
    holdRead: yield* Ref.make(false),
    readStarted: yield* Deferred.make<void>(),
    releaseRead: yield* Deferred.make<void>(),
    holdFirstStop: yield* Ref.make(false),
    stopStarted: yield* Deferred.make<void>(),
    releaseStop: yield* Deferred.make<void>(),
    sent: yield* Ref.make<ReadonlyArray<string>>([]),
    afterLaunch: yield* Ref.make<Effect.Effect<void>>(Effect.void),
    resources: yield* Ref.make(loadOf(0.1)),
  } satisfies BoxThread;
});

/** The box's projects: more than a page, with this repository's last. */
const boxProjects: ReadonlyArray<Project> = [
  ...Array.from({ length: 120 }, (_, index) => ({
    id: ProjectId.make(`project:box-other-${index}`),
    title: `other ${index}`,
    workspaceRoot: `/srv/other-${index}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    deletedAt: null,
  })),
  {
    id: boxProject,
    title: "app",
    workspaceRoot: "/srv/app",
    repositoryIdentity: {
      canonicalKey: "github.com/acme/app",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "git@github.com:acme/app.git",
      },
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    deletedAt: null,
  },
];

const serveBox = (thread: BoxThread) => {
  return servePeer(box, boxToolkitLayer(thread));
};

const boxRunId = RunId.make("run:box");
const boxLaterRunId = RunId.make("run:box-later");
const boxQueuedRunId = RunId.make("run:box-queued");
const continuationOf = (runId: RunId) => RunId.make(`${runId}:restarted`);

const boxToolkitLayer = (thread: BoxThread) => {
  const runId = boxRunId;
  const interrupts = new Set<string>();
  const shellOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(thread.launched)) !== threadId) return null;
      const linkOrigin = yield* Ref.get(thread.linkOrigin);
      return {
        ...liveThreadShell(threadId, { runtimeMode: "full-access" }),
        projectId: boxProject,
        ...(linkOrigin === null ? {} : { linkOrigin }),
      };
    });
  const runOf = (status: OrchestrationV2Run["status"]) =>
    ({
      id: runId,
      threadId: ThreadId.make("thread:box"),
      ordinal: 1,
      status,
      modelSelection,
      activeAttemptId: "attempt:box",
      requestedAt: DateTime.makeUnsafe(0),
      startedAt: DateTime.makeUnsafe(0),
      completedAt: null,
    }) as unknown as OrchestrationV2Run;
  const projectionOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* shellOf(threadId);
      const status = yield* Ref.get(thread.status);
      const runless = yield* Ref.get(thread.runless);
      const model = yield* Ref.get(thread.executedModel);
      return shell === null
        ? (null as never)
        : {
            ...idleThreadProjection(shell),
            runs: runless ? [] : [runOf(status)],
            providerTurns: (model === null
              ? []
              : [{ runAttemptId: "attempt:box", ordinal: 1, model }]) as never,
          };
    });
  // One record per command id, as its receipt replays a repeat.
  const recordStop = (commandId: string, kind: "interrupt" | "thread.stop" | "delegated-tasks") =>
    Effect.gen(function* () {
      if (interrupts.has(`${kind}:${commandId}`)) return;
      interrupts.add(`${kind}:${commandId}`);
      yield* Ref.update(thread.stops, (seen) => [...seen, kind]);
      if (kind !== "delegated-tasks") {
        yield* Ref.update(thread.interrupted, (count) => count + 1);
        yield* Deferred.succeed(thread.interruptedOnce, undefined);
      }
    });
  const layerBoxThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: shellOf,
    getProjectThreadRecords: (input) => projectionOf(input.threadId),
    getThreadRecords: (threadId) => projectionOf(threadId),
    waitForThread: (input) =>
      Effect.gen(function* () {
        yield* Ref.update(thread.waitedFor, (seen) => [...seen, input.runId]);
        // A thread with no run has nothing to wait for.
        if (yield* Ref.get(thread.runless)) {
          return { threadId: input.threadId, run: null, timedOut: false };
        }
        if (yield* Ref.get(thread.gone)) {
          return yield* new ThreadManagement.ThreadManagementThreadNotFoundError({
            projectId: boxProject,
            threadId: input.threadId,
          });
        }
        // The queued run's own task stays open while the follow-up ahead of it settles.
        if (input.runId === boxQueuedRunId) return yield* Effect.never;
        if (input.runId === boxLaterRunId) {
          const laterDone = yield* Deferred.await(thread.laterFinished).pipe(
            Effect.timeoutOption(input.timeoutMs),
          );
          // Settled, the thread's answer is the run queued behind it, once there is one.
          const queued =
            Option.isSome(laterDone) &&
            input.untilDelegatedWorkSettled === true &&
            (yield* Ref.get(thread.queuedReply)) !== null;
          // A restarted run is reported as its continuation, as the box follows the chain.
          const restarted = (yield* Ref.get(thread.restart))?.of;
          const latest = (runId: RunId) => (runId === restarted ? continuationOf(runId) : runId);
          return {
            threadId: input.threadId,
            run: {
              id: latest(boxLaterRunId),
              status: Option.isSome(laterDone) ? "completed" : "running",
            } as OrchestrationV2Run,
            timedOut: Option.isNone(laterDone),
            ...(queued
              ? {
                  resultRun: {
                    id: latest(boxQueuedRunId),
                    status: "completed",
                  } as OrchestrationV2Run,
                }
              : {}),
          };
        }
        const done = yield* Deferred.await(thread.finished).pipe(
          Effect.timeoutOption(input.timeoutMs),
        );
        // Only a waiter that asks waits past the run for the thread's own task.
        if (
          Option.isSome(done) &&
          input.untilDelegatedWorkSettled === true &&
          (yield* Ref.get(thread.nested))
        ) {
          yield* Deferred.succeed(thread.nestedWaiting, undefined);
          const settled = yield* Deferred.await(thread.nestedSettled).pipe(
            Effect.timeoutOption(input.timeoutMs),
          );
          return {
            threadId: input.threadId,
            run: { id: runId, status: yield* Ref.get(thread.status) } as OrchestrationV2Run,
            timedOut: Option.isNone(settled),
            ...(Option.isSome(settled)
              ? { resultRun: { id: boxLaterRunId, status: "completed" } as OrchestrationV2Run }
              : {}),
          };
        }
        // Unpinned, a wait reports the latest run: a later one once there is one.
        const later = input.runId === undefined && (yield* Ref.get(thread.laterReply)) !== null;
        return {
          threadId: input.threadId,
          run: {
            id: later ? boxLaterRunId : runId,
            status: later ? "completed" : yield* Ref.get(thread.status),
          } as OrchestrationV2Run,
          timedOut: Option.isNone(done),
        };
      }),
    getTimelinePage: (threadId, options) =>
      Effect.gen(function* () {
        if (yield* Ref.get(thread.holdRead)) {
          yield* Deferred.succeed(thread.readStarted, undefined);
          yield* Deferred.await(thread.releaseRead);
        }
        const reply = yield* Ref.get(thread.reply);
        const later = yield* Ref.get(thread.laterReply);
        const queued = yield* Ref.get(thread.queuedReply);
        const error = yield* Ref.get(thread.error);
        const laterError = yield* Ref.get(thread.laterError);
        const restart = yield* Ref.get(thread.restart);
        // One item per page, with errors available only in the activity view.
        const replies = [
          ...(reply === null
            ? []
            : [
                {
                  id: TurnItemId.make("item:reply"),
                  runId,
                  text: reply,
                  type: "assistant_message",
                },
              ]),
          ...(error === null
            ? []
            : [{ id: TurnItemId.make("item:error"), runId, text: error, type: "error" }]),
          ...(later === null
            ? []
            : [
                {
                  id: TurnItemId.make("item:later-reply"),
                  runId: boxLaterRunId,
                  text: later,
                  type: "assistant_message",
                },
              ]),
          ...(laterError === null
            ? []
            : [
                {
                  id: TurnItemId.make("item:later-error"),
                  runId: boxLaterRunId,
                  text: laterError,
                  type: "error",
                },
              ]),
          ...(queued === null
            ? []
            : [
                {
                  id: TurnItemId.make("item:queued-reply"),
                  runId: boxQueuedRunId,
                  text: queued,
                  type: "assistant_message",
                },
              ]),
          ...(restart === null
            ? []
            : [
                {
                  id: TurnItemId.make("item:restarted-reply"),
                  runId: continuationOf(restart.of),
                  text: restart.reply,
                  type: "assistant_message",
                },
              ]),
        ].map((entry, position) => ({ ...entry, position }));
        const visible =
          options.itemId === undefined
            ? replies.filter(
                (entry) => options.view === "activity" || entry.type === "assistant_message",
              )
            : replies.filter((entry) => entry.id === options.itemId);
        const matching = visible
          .filter((entry) => entry.position > (options.afterPosition ?? -1))
          .slice(0, 1);
        return {
          items: matching.map(({ id, runId: itemRunId, text, position, type }) => ({
            position,
            visibility: "local" as const,
            sourceThreadId: threadId,
            sourceItemId: id,
            item: {
              id,
              threadId,
              runId: itemRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed" as const,
              title: null,
              startedAt: DateTime.makeUnsafe(0),
              completedAt: DateTime.makeUnsafe(0),
              updatedAt: DateTime.makeUnsafe(0),
              ...(type === "error"
                ? { type, failure: { message: text } }
                : {
                    type: "assistant_message" as const,
                    messageId: MessageId.make(`message:${id}`),
                    text,
                    streaming: false,
                  }),
            } as never,
          })),
          totalItems: replies.length,
          hasMore:
            options.itemId === undefined &&
            matching.length > 0 &&
            visible.some((entry) => entry.position > matching.at(-1)!.position),
          hasEarlier: false,
        };
      }),
    interruptThread: (input) =>
      recordStop(input.commandId, "interrupt").pipe(
        Effect.as({ type: "interrupt_requested", run: runOf("running") } as never),
      ),
    dispatch: (command) =>
      command.type === "thread.stop"
        ? recordStop(command.commandId, "thread.stop").pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                if (!(yield* Ref.getAndSet(thread.holdFirstStop, false))) return;
                yield* Deferred.succeed(thread.stopStarted, undefined);
                yield* Deferred.await(thread.releaseStop);
              }),
            ),
            Effect.as({ sequence: 0, storedEvents: [] } as never),
          )
        : Effect.die(`The box does not expect ${command.type}`),
    stopDelegatedTasks: (input) => recordStop(input.commandId, "delegated-tasks"),
    sendToThread: (input) =>
      Ref.update(thread.sent, (seen) => [...seen, input.text]).pipe(
        Effect.as(
          (input.mode === "queue"
            ? { run: { id: boxQueuedRunId, status: "queued" }, delivery: "queued" }
            : { run: { id: boxLaterRunId, status: "running" }, delivery: "started" }) as never,
        ),
      ),
  });
  const layerBoxLaunches = Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: (input) =>
      Ref.get(thread.runless).pipe(
        Effect.flatMap((runless) =>
          Ref.set(thread.launched, input.threadId!).pipe(
            Effect.andThen(Ref.set(thread.linkOrigin, input.linkOrigin ?? null)),
            Effect.andThen(Ref.set(thread.delegatedFrom, input.delegatedFrom ?? null)),
            Effect.andThen(Ref.set(thread.message, input.initialMessage?.text ?? null)),
            Effect.andThen(
              Ref.set(thread.launchedWith, {
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
              }),
            ),
            Effect.andThen(Effect.flatten(Ref.get(thread.afterLaunch))),
            Effect.as({
              threadId: input.threadId,
              projection: {
                thread: {
                  id: input.threadId,
                  projectId: input.projectId,
                  title: input.title,
                  modelSelection: input.modelSelection,
                },
                runs:
                  input.initialMessage?.messageId && !runless
                    ? [
                        {
                          id: runId,
                          status: "running",
                          userMessageId: input.initialMessage.messageId,
                        },
                      ]
                    : [],
              },
              resumed: false,
            } as unknown as ThreadLaunch.ThreadLaunchResult),
          ),
        ),
      ),
  });
  return Layer.merge(
    McpHttpServer.layerOrchestratorToolkit,
    McpHttpServer.layerProjectRegistration,
  ).pipe(
    Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(layerBoxThreads),
    Layer.provide(
      Layer.merge(
        layerBoxLaunches,
        Layer.succeed(HostResources.HostResources, { read: Ref.get(thread.resources) }),
      ),
    ),
    Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
    Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
    Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
    Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/p" }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-remote-delegation-box-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([boxClaude]),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([boxClaude.instanceId]),
      }),
    ),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(Option.fromNullishOr(boxProjects.find((project) => project.id === id))),
        // More than a page, so finding the project with this repository pages.
        listPage: ({ cursor, limit }) =>
          Effect.succeed({
            projects: boxProjects.slice(cursor, cursor + limit),
            nextCursor: cursor + limit < boxProjects.length ? cursor + limit : null,
          }),
      }),
    ),
    Layer.provide(Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({})),
    Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(NodeServices.layer),
  );
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "remote-delegation", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "remote-delegation", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/** The box's only provider: a Claude instance, under its own id. */
const boxClaude: ServerProvider = {
  instanceId: ProviderInstanceId.make("claude-box"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-13T00:00:00.000Z",
  models: [
    { slug: "claude-sonnet-4-6", name: "Claude Sonnet", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/**
 * The laptop: a real orchestrator (in-memory SQLite) whose parent thread has
 * a live run, the real orchestrator toolkit, and RemoteDelegation. Built in
 * its own scope so a test can tear it down and build it again on the same
 * database, as a restart does.
 */
const makeLaptop = (
  database: Context.Context<SqlClient.SqlClient>,
  offers: SubscriptionRef.SubscriptionRef<
    ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
  >,
  /** The laptop's links from before a restart, which keep their sessions there. */
  kept?: Context.Context<Layer.Success<ReturnType<typeof layerLinkingEnvironment>>>,
  /** Runs as each follow attempt here starts, on its follower's fiber. */
  beforeFollow: Effect.Effect<void, Orchestrator.OrchestratorV2Error> = Effect.void,
  /** Interleavings for delegation only: the transport keeps the real links. */
  hooks: {
    /** Runs once delegation has bound an intent, before it acts on it. */
    readonly afterBindIntent?: (commandId: string) => Effect.Effect<void>;
    /** Runs once delegation has read the link session it binds a launch to. */
    readonly afterSession?: (session: Option.Option<string>) => Effect.Effect<void>;
    /** Runs whenever something here reaches for a local launch, which this harness cannot make. */
    readonly localLaunch?: Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const linking = kept ?? (yield* layerLinkingEnvironment(laptop).pipe(Layer.build));
    const layerDatabase = Layer.succeedContext(database);
    const layerOrchestrator = Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "remote-delegation-laptop" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ).pipe(
      Layer.provide(
        Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) => SubscriptionRef.update(offers, (seen) => [...seen, request]),
          take: Effect.never,
        }),
      ),
    );
    const layerThreads = ThreadManagement.layer.pipe(
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
      Layer.provideMerge(Layer.merge(layerOrchestrator, ServerSettings.layerTest())),
    );
    // Its project tools too, so an outside client here can launch top-level threads.
    const layerHere = Layer.merge(
      McpHttpServer.layerOrchestratorToolkit,
      McpHttpServer.layerProjectRegistration,
    ).pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provideMerge(
        RemoteDelegation.layer.pipe(
          Layer.provide(
            Layer.effect(
              ThreadManagement.ThreadManagementService,
              Effect.gen(function* () {
                const threads = yield* ThreadManagement.ThreadManagementService;
                return {
                  ...threads,
                  getThreadEventSequence: (threadId: ThreadId) =>
                    beforeFollow.pipe(Effect.andThen(threads.getThreadEventSequence(threadId))),
                  bindIntent: (input: Parameters<typeof threads.bindIntent>[0]) =>
                    threads
                      .bindIntent(input)
                      .pipe(
                        Effect.tap(() => hooks.afterBindIntent?.(input.commandId) ?? Effect.void),
                      ),
                };
              }),
            ),
          ),
          Layer.provide(
            Layer.effect(
              PeerLinks.PeerLinks,
              Effect.gen(function* () {
                const links = yield* PeerLinks.PeerLinks;
                return {
                  ...links,
                  session: (environmentId: Parameters<typeof links.session>[0]) =>
                    links
                      .session(environmentId)
                      .pipe(Effect.tap((session) => hooks.afterSession?.(session) ?? Effect.void)),
                };
              }),
            ),
          ),
          Layer.provideMerge(PeerForwarding.layer),
          Layer.provide(
            Layer.mock(ProjectService.ProjectService)({
              // A cold enrichment cache: the project itself reports no identity yet.
              getById: () =>
                Effect.succeedSome({
                  workspaceRoot: "/home/me/app",
                  repositoryIdentity: null,
                } as never),
            }),
          ),
          Layer.provide(
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: (cwd) =>
                Effect.succeed(
                  cwd === "/home/me/app"
                    ? ({ canonicalKey: "github.com/acme/app" } as RepositoryIdentity)
                    : null,
                ),
            }),
          ),
        ),
      ),
      Layer.provide(Layer.succeedContext(linking)),
      Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(layerThreads),
      // The laptop lists no provider of its own, so it never runs the box's model.
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      ),
      Layer.provide(
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeedSome({ ...laptopProject, id }),
        }),
      ),
      Layer.provide(Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: () =>
            (hooks.localLaunch ?? Effect.void).pipe(Effect.andThen(Effect.die("no local launch"))),
          checkWorktreeBase: () =>
            (hooks.localLaunch ?? Effect.void).pipe(Effect.andThen(Effect.die("no local launch"))),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.merge(
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/p" }),
          Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
        ),
      ),
      Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-remote-delegation-laptop-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.fresh,
    );
    const here = yield* Layer.build(layerHere);
    const server = Context.get(here, McpServer.McpServer);
    return {
      links: Context.get(linking, PeerLinks.PeerLinks),
      settings: Context.get(linking, ServerSettings.ServerSettingsService),
      orchestrator: Context.get(here, Orchestrator.OrchestratorV2),
      remote: Context.get(here, RemoteDelegation.RemoteDelegation),
      threads: Context.get(here, ThreadManagement.ThreadManagementService),
      projections: Context.get(here, ProjectionStore.ProjectionStoreV2),
      sink: Context.get(here, EventSink.EventSinkV2),
      call: (name: string, args: Record<string, unknown>, scope = parentScope) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, mcpClient),
          ),
    };
  });

const parentThreadId = ThreadId.make("thread:laptop-parent");
const parentRunId = RunId.make("run:laptop-parent");
const parentRootNode = NodeId.make("node:laptop-parent:root");
const parentScope: McpInvocationContext.McpInvocationScope = {
  environmentId: laptop.environmentId,
  requestNamespace: "provider-session:laptop-parent",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:laptop-parent",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

/** The laptop's project, with this repository, as its project tools read it. */
const laptopProject: Project = {
  id: ProjectId.make("project:laptop"),
  title: "app",
  workspaceRoot: "/home/me/app",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
};

/** An outside client of the laptop, such as the t3 CLI or another agent, in no thread. */
const outsideScope: McpInvocationContext.McpInvocationScope = {
  environmentId: laptop.environmentId,
  requestNamespace: "client:outside-session",
  thread: undefined,
  client: {
    sessionId: "outside-session",
    label: "t3 thread cli",
    access: "full-access",
    linked: false,
  },
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
  issuedAt: 1,
};

/** A top-level thread placed by capacity, for the box's Claude model. */
const launchPlaced = (
  laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>,
  args: Record<string, unknown>,
) =>
  laptopEnv.call(
    "t3_thread_launch",
    {
      projectId: "project:laptop",
      title: "Suite",
      message: "Run the suite wherever there is room.",
      modelSelection: { instanceId: boxClaude.instanceId, model: "claude-sonnet-4-6" },
      placement: "auto",
      ...args,
    },
    outsideScope,
  );

/** The laptop's parent thread, mid-turn when its agent delegates. */
const seedParent = (
  laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>,
  parentModelSelection: ModelSelection = modelSelection,
  interactionMode: "default" | "plan" = "default",
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make("provider-thread:laptop-parent");
    yield* laptopEnv.orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:create:laptop-parent"),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:laptop"),
      title: "Laptop parent",
      modelSelection: parentModelSelection,
      runtimeMode: "full-access",
      interactionMode,
      branch: null,
      worktreePath: null,
    });
    yield* laptopEnv.sink.write({
      commandId: CommandId.make("command:seed:laptop-parent"),
      events: [
        {
          id: EventId.make("event:seed-provider-thread:laptop-parent"),
          type: "provider-thread.updated",
          threadId: parentThreadId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: parentThreadId,
            ownerNodeId: parentRootNode,
            nativeThreadRef: { driver, nativeId: "native:laptop-parent", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("event:seed-node:laptop-parent"),
          type: "node.updated",
          threadId: parentThreadId,
          runId: parentRunId,
          nodeId: parentRootNode,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: parentRootNode,
            threadId: parentThreadId,
            runId: parentRunId,
            parentNodeId: null,
            rootNodeId: parentRootNode,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make("event:seed-run:laptop-parent"),
          type: "run.updated",
          threadId: parentThreadId,
          runId: parentRunId,
          nodeId: parentRootNode,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: parentRunId,
            threadId: parentThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection: parentModelSelection,
            providerThreadId,
            userMessageId: MessageId.make("message:seed-user:laptop-parent"),
            rootNodeId: parentRootNode,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
  });

const delegateToBox = (laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>) =>
  laptopEnv
    .call("delegate_task", {
      task: "Run the full suite on the box.",
      target: {
        environmentId: box.environmentId,
        providerInstanceId: instanceId,
        model: "gpt-5.4",
      },
      mode: "async",
      clientRequestId: "suite-on-box",
    })
    .pipe(
      Effect.map((result) => {
        expect(result.isError, JSON.stringify(result.content)).toBe(false);
        return result.structuredContent as {
          taskId: NodeId;
          status: string;
          childThreadId: null;
          remoteChild: { environmentId: string; threadId: ThreadId; label: string };
          link?: string;
        };
      }),
    );

/** A task placed by capacity, for the box's Claude model, which the laptop does not run. */
const autoTask = (
  laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>,
  clientRequestId: string,
  target: Record<string, unknown> = {},
) =>
  laptopEnv.call("delegate_task", {
    task: "Run the suite wherever there is room.",
    placement: "auto",
    target: { providerInstanceId: boxClaude.instanceId, model: "claude-sonnet-4-6", ...target },
    clientRequestId,
  });

/** Waits until the task here has the result its thread there ended with. */
const taskResult = (laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>, taskId: NodeId) =>
  laptopEnv.orchestrator
    .streamStoredEventsFrom({
      threadId: parentThreadId,
      afterSequence: 0,
      eventType: "subagent.updated",
    })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "subagent.updated" &&
          stored.event.payload.id === taskId &&
          stored.event.payload.result !== null,
      ),
      Stream.runHead,
      Effect.map((stored) =>
        Option.isSome(stored) && stored.value.event.type === "subagent.updated"
          ? stored.value.event.payload
          : undefined,
      ),
    );

it.effect("a task delegated to the box wakes the laptop's parent when it ends there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const delegated = yield* delegateToBox(a);
      expect(delegated).toMatchObject({
        status: "running",
        childThreadId: null,
        remoteChild: { environmentId: box.environmentId, label: "Box" },
      });
      // The box launched it in the project with the same repository.
      expect(yield* Ref.get(thread.launched)).toBe(delegated.remoteChild.threadId);
      // Its link opens the thread there, so the parent can mention it like any other.
      expect(delegated.link).toBe(
        `[Laptop parent](t3-thread://v2/${box.environmentId}/${delegated.remoteChild.threadId})`,
      );
      // ...naming the parent here, so the thread there links back to it.
      expect(yield* Ref.get(thread.delegatedFrom)).toEqual({
        environmentId: laptop.environmentId,
        threadId: parentThreadId,
        title: "Laptop parent",
      });
      // A retry with the same key launches nothing new and records nothing new.
      const retried = yield* delegateToBox(a);
      expect(retried.taskId).toBe(delegated.taskId);
      expect((yield* a.orchestrator.getThreadProjection(parentThreadId)).subagents).toHaveLength(1);

      // Its provider there has not started the turn yet.
      yield* Ref.set(thread.status, "starting");
      const starting = yield* a.call("task_status", { taskId: delegated.taskId });
      expect(starting.structuredContent).toMatchObject({
        status: "starting",
        workState: "working",
      });
      yield* Ref.set(thread.status, "running");

      const historyReads: Array<string> = [];
      const historyTracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            const query = span.attributes.get("db.query.text");
            if (
              typeof query === "string" &&
              /\bSELECT\s+payload_json\s+FROM orchestration_v2_projection_(?:runs|context_transfers)\b/i.test(
                query,
              )
            ) {
              historyReads.push(query);
            }
          };
          return span;
        },
      });
      const running = yield* a
        .call("task_status", { taskId: delegated.taskId })
        .pipe(Effect.withTracer(historyTracer));
      expect(running.structuredContent).toMatchObject({
        taskId: delegated.taskId,
        childThreadId: null,
        remoteChild: delegated.remoteChild,
        status: "running",
        workState: "working",
        summary: null,
        hasPendingQuestion: false,
        pendingApproval: null,
      });
      // A running task there needs its local row, not the parent's run or transfer history.
      expect(historyReads).toEqual([]);

      yield* Ref.set(thread.reply, "All 412 tests pass on the box.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      const task = yield* taskResult(a, delegated.taskId);
      expect(task).toMatchObject({ status: "completed", result: "All 412 tests pass on the box." });
      // The parent's live run claims the result, as for a child here.
      const parentRun = (yield* a.orchestrator.getThreadProjection(parentThreadId)).runs.find(
        (run) => run.id === parentRunId,
      );
      expect(parentRun?.delegatedCompletion?.delivery?.taskIds).toEqual([delegated.taskId]);
      // The wake is offered after the result commits, so the result can be seen first.
      const offered = yield* SubscriptionRef.changes(offers).pipe(
        Stream.filter((seen) => seen.some((offer) => offer.threadId === parentThreadId)),
        Stream.runHead,
      );
      expect(Option.isSome(offered)).toBe(true);

      const messageReads: Array<string> = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            const query = span.attributes.get("db.query.text");
            if (
              typeof query === "string" &&
              /SELECT[\s\S]*FROM orchestration_v2_projection_messages/i.test(query)
            ) {
              messageReads.push(query);
            }
          };
          return span;
        },
      });
      const status = yield* a
        .call("task_status", { taskId: delegated.taskId })
        .pipe(Effect.withTracer(tracer));
      expect(status.structuredContent).toMatchObject({
        status: "completed",
        summary: "All 412 tests pass on the box.",
      });
      // Delivery validation still reads messages; choosing the observer does not need another read.
      expect(messageReads).toHaveLength(2);
      expect(messageReads.filter((query) => !/\bmessage_id\s+IN\b/i.test(query))).toHaveLength(1);
      const acknowledged = yield* a.projections.getThreadRecords(parentThreadId, ["subagents"], {
        subagentIds: [delegated.taskId],
      });
      expect(acknowledged.subagents[0]?.completionDelivery).toEqual({
        state: "acknowledged",
        observedByRunId: parentRunId,
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each(["no active parent run", "a newer run owned by another provider"] as const)(
  "preserves remote observation guards with %s",
  (observer) =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);
        const delegated = yield* delegateToBox(a);

        yield* Ref.set(thread.reply, "Remote result remains available.");
        yield* Ref.set(thread.status, "completed");
        yield* Deferred.succeed(thread.finished, undefined);
        yield* taskResult(a, delegated.taskId);
        yield* SubscriptionRef.changes(offers).pipe(
          Stream.filter((seen) => seen.some((offer) => offer.threadId === parentThreadId)),
          Stream.runHead,
        );

        const parent = yield* a.projections.getThreadRecords(
          parentThreadId,
          ["runs", "subagents"],
          {
            subagentIds: [delegated.taskId],
          },
        );
        expect(parent.subagents[0]?.completionDelivery?.state).not.toBe("acknowledged");
        const parentRun = parent.runs.find((run) => run.id === parentRunId);
        if (parentRun === undefined) return yield* Effect.die("The parent run was not seeded.");
        const now = yield* DateTime.now;
        const otherInstanceId = ProviderInstanceId.make("codex-other");
        const observingRun: OrchestrationV2Run =
          observer === "no active parent run"
            ? { ...parentRun, status: "completed", completedAt: now }
            : {
                id: RunId.make("run:laptop-other-provider"),
                threadId: parentThreadId,
                ordinal: parentRun.ordinal + 1,
                providerInstanceId: otherInstanceId,
                modelSelection: { instanceId: otherInstanceId, model: "gpt-5.4" },
                providerThreadId: null,
                userMessageId: MessageId.make("message:laptop-other-provider"),
                rootNodeId: null,
                activeAttemptId: null,
                status: "preparing",
                requestedAt: now,
                startedAt: null,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              };
        yield* a.sink.write({
          commandId: CommandId.make("command:change-remote-result-observer"),
          events: [
            {
              id: EventId.make("event:change-remote-result-observer"),
              type: "run.updated",
              threadId: parentThreadId,
              runId: observingRun.id,
              providerInstanceId: observingRun.providerInstanceId,
              occurredAt: now,
              payload: observingRun,
            },
          ],
        });

        const status = yield* a.call("task_status", { taskId: delegated.taskId });
        if (observer === "no active parent run") {
          expect(status.isError).toBe(true);
          expect(status.content).toEqual([
            {
              type: "text",
              text: JSON.stringify({
                _tag: "OrchestratorMcpFailure",
                code: "parent_not_active",
                message: "The calling provider no longer owns an active thread run.",
              }),
            },
          ]);
          const unacknowledged = yield* a.projections.getThreadRecords(
            parentThreadId,
            ["subagents"],
            { subagentIds: [delegated.taskId] },
          );
          expect(unacknowledged.subagents[0]?.result).toBe("Remote result remains available.");
          expect(unacknowledged.subagents[0]?.completionDelivery?.state).not.toBe("acknowledged");
          return;
        }
        expect(status.isError, JSON.stringify(status.content)).not.toBe(true);
        expect(status.structuredContent).toMatchObject({
          status: "completed",
          summary: "Remote result remains available.",
        });
        const acknowledged = yield* a.projections.getThreadRecords(parentThreadId, ["subagents"], {
          subagentIds: [delegated.taskId],
        });
        expect(acknowledged.subagents[0]?.completionDelivery).toEqual({
          state: "acknowledged",
          observedByRunId: parentRunId,
        });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "with the beta off here, a task already running there still ends, and no new one starts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);
        const delegated = yield* delegateToBox(a);

        yield* a.settings.updateSettings({ linkedEnvironmentsEnabled: false });
        const refused = yield* a.call("delegate_task", {
          task: "Run the linter on the box.",
          target: {
            environmentId: box.environmentId,
            providerInstanceId: instanceId,
            model: "gpt-5.4",
          },
          mode: "async",
          clientRequestId: "lint-on-box",
        });
        expect(refused.isError).toBe(true);
        expect(JSON.stringify(refused.content)).toContain(
          PeerForwarding.linkedEnvironmentsOff.message,
        );
        expect((yield* a.orchestrator.getThreadProjection(parentThreadId)).subagents).toHaveLength(
          1,
        );

        yield* Ref.set(thread.reply, "All 412 tests pass on the box.");
        yield* Ref.set(thread.status, "completed");
        yield* Deferred.succeed(thread.finished, undefined);
        expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
          status: "completed",
          result: "All 412 tests pass on the box.",
        });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task named only by environment inherits the parent's model, within the link", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      // The parent runs with full access; the link allows less.
      yield* linkTo(a.links, b, "auto-accept-edits");
      // An explicit Standard must survive, or a Daybreak default there would replace it.
      const parentModelSelection = {
        ...modelSelection,
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "cyberAccessProgram", value: "standard" },
        ],
      };
      yield* seedParent(a, parentModelSelection);

      const result = yield* a.call("delegate_task", {
        task: "Run the suite on the box.",
        target: { environmentId: box.environmentId },
      });
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
      // The parent's model and options, and the link's modes rather than the parent's.
      expect(yield* Ref.get(thread.launchedWith)).toEqual({
        modelSelection: parentModelSelection,
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
      });

      // Asking for more than the link allows is still refused there.
      const broader = yield* a.call("delegate_task", {
        task: "Run the suite on the box.",
        target: { environmentId: box.environmentId },
        runtimeMode: "full-access",
        clientRequestId: "broader",
      });
      expect(broader.isError).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task naming another driver there never runs its model on the parent's instance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const result = yield* a.call("delegate_task", {
        task: "Run the suite on the box.",
        target: {
          environmentId: box.environmentId,
          driverKind: "claudeAgent",
          model: "claude-sonnet-4-6",
        },
      });
      expect(result.isError).toBe(false);
      expect((yield* Ref.get(thread.launchedWith))?.modelSelection.instanceId).toBe(
        boxClaude.instanceId,
      );
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses worktree isolation for a task there before launching anything", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "auto");
      yield* seedParent(a);

      const result = yield* a.call("delegate_task", {
        task: "Run the suite on the box.",
        target: { environmentId: box.environmentId },
        isolation: "worktree",
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("isolation");
      expect(yield* Ref.get(thread.launched)).toBeNull();
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("follows an open task again after the laptop restarts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      // The laptop before the restart delegates, then goes away.
      const delegated = yield* Effect.scoped(
        Effect.gen(function* () {
          const before = yield* makeLaptop(database, offers);
          yield* linkTo(before.links, b, "full-access");
          yield* seedParent(before);
          return yield* delegateToBox(before);
        }),
      );
      // The task finishes on the box while the laptop is down.
      yield* Ref.set(thread.reply, "Finished while you were away.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);

      const after = yield* makeLaptop(database, offers);
      // The link lives in the laptop's own store, so it needs linking again here.
      yield* linkTo(after.links, b, "full-access");
      yield* after.remote.start();
      const task = yield* taskResult(after, delegated.taskId);
      expect(task).toMatchObject({ status: "completed", result: "Finished while you were away." });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("an auto-placed task keeps its environment after a lost answer and a restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      // Its link outlives the restart, so the box knows it as the same link session.
      const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
      // The box takes the launch with room to spare, but its answer never arrives.
      yield* Ref.set(thread.afterLaunch, Effect.die("connection lost"));
      const lost = yield* Effect.scoped(
        Effect.gen(function* () {
          const before = yield* makeLaptop(database, offers, linking);
          yield* linkTo(before.links, b, "full-access");
          yield* seedParent(before);
          return yield* autoTask(before, "auto-suite");
        }),
      );
      expect(lost.isError).toBe(true);
      const launchedThere = yield* Ref.get(thread.launched);
      expect(launchedThere).not.toBeNull();

      // The box fills up while the laptop restarts: choosing afresh finds nowhere.
      yield* Ref.set(thread.resources, loadOf(0.99));
      yield* Ref.set(thread.afterLaunch, Effect.void);
      const after = yield* makeLaptop(database, offers, linking);
      const fresh = yield* autoTask(after, "another-suite");
      expect(fresh.isError).toBe(true);
      expect(JSON.stringify(fresh.content)).toContain("no-eligible-environment");
      expect(yield* Ref.get(thread.launched)).toBe(launchedThere);

      // The retry keeps the binding: the same thread there, recorded once here.
      const retried = yield* autoTask(after, "auto-suite");
      expect(retried.isError, JSON.stringify(retried.content)).toBe(false);
      expect(retried.structuredContent).toMatchObject({
        remoteChild: { environmentId: box.environmentId, threadId: launchedThere },
      });
      expect((yield* Ref.get(thread.launchedWith))?.modelSelection).toEqual({
        instanceId: boxClaude.instanceId,
        model: "claude-sonnet-4-6",
      });
      expect(
        (yield* after.orchestrator.getThreadProjection(parentThreadId)).subagents,
      ).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "an auto-placed top-level launch keeps its environment after a lost answer and a restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        // Its link outlives the restart, so the box knows it as the same link session.
        const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
        // The box starts the thread with room to spare, but its answer never arrives.
        yield* Ref.set(thread.afterLaunch, Effect.die("connection lost"));
        const lost = yield* Effect.scoped(
          Effect.gen(function* () {
            const before = yield* makeLaptop(database, offers, linking);
            yield* linkTo(before.links, b, "full-access");
            return yield* launchPlaced(before, { clientRequestId: "top-level" });
          }),
        );
        expect(lost.isError).toBe(true);
        const lostThere = yield* Ref.get(thread.launched);
        expect(lostThere).not.toBeNull();

        // The box fills up while this side restarts: choosing afresh finds nowhere.
        yield* Ref.set(thread.resources, loadOf(0.99));
        yield* Ref.set(thread.afterLaunch, Effect.void);
        const after = yield* makeLaptop(database, offers, linking);
        const fresh = yield* launchPlaced(after, { clientRequestId: "another" });
        expect(fresh.isError).toBe(true);
        expect(JSON.stringify(fresh.content)).toContain("no-eligible-environment");
        // Without a key there is nothing a retry could find again, so nothing is placed.
        const keyless = yield* launchPlaced(after, {});
        expect(keyless.isError).toBe(true);
        expect(JSON.stringify(keyless.content)).toContain("clientRequestId");
        expect(yield* Ref.get(thread.launched)).toBe(lostThere);

        // The retry keeps the binding: the same thread there, with the exact model and modes.
        const retried = yield* launchPlaced(after, { clientRequestId: "top-level" });
        expect(retried.isError, JSON.stringify(retried.content)).toBe(false);
        expect((retried.structuredContent as { threadId: ThreadId }).threadId).toBe(lostThere);
        expect(yield* Ref.get(thread.launchedWith)).toEqual({
          modelSelection: { instanceId: boxClaude.instanceId, model: "claude-sonnet-4-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });

        // A named environment wins over placement: it launches there although the box is full,
        // in the project named with that environment's ids.
        const pinned = yield* launchPlaced(after, {
          environmentId: box.environmentId,
          projectId: boxProject,
          clientRequestId: "pinned",
        });
        expect(pinned.isError, JSON.stringify(pinned.content)).toBe(false);
        expect((pinned.structuredContent as { threadId: ThreadId }).threadId).not.toBe(lostThere);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("an outside client's auto-placed launch starts at the project's default mode", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      // The client may run anything; this project starts its threads approval-required.
      yield* a.settings.updateSettings({
        projectSettingsOverrides: {
          [laptopProject.id]: { defaultRuntimeMode: "approval-required" },
        },
      });
      yield* linkTo(a.links, b, "full-access");
      const launched = yield* launchPlaced(a, { clientRequestId: "defaults" });
      expect(launched.isError, JSON.stringify(launched.content)).toBe(false);
      expect((yield* Ref.get(thread.launchedWith))?.runtimeMode).toBe("approval-required");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "a retry that drops placement or asks for this checkout reaches the thread placed there",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const localLaunches = yield* Ref.make(0);
        const a = yield* makeLaptop(database, offers, undefined, Effect.void, {
          localLaunch: Ref.update(localLaunches, (count) => count + 1),
        });
        yield* linkTo(a.links, b, "full-access");
        // The box takes the launch, but its answer is lost.
        yield* Ref.set(thread.afterLaunch, Effect.die("connection lost"));
        expect((yield* launchPlaced(a, { clientRequestId: "kept" })).isError).toBe(true);
        const placedThere = yield* Ref.get(thread.launched);
        expect(placedThere).not.toBeNull();
        yield* Ref.set(thread.afterLaunch, Effect.void);

        // The same request without placement is the same intent: it reaches that thread.
        const unplaced = yield* a.call(
          "t3_thread_launch",
          {
            projectId: "project:laptop",
            title: "Suite",
            message: "Run the suite wherever there is room.",
            modelSelection: { instanceId: boxClaude.instanceId, model: "claude-sonnet-4-6" },
            clientRequestId: "kept",
          },
          outsideScope,
        );
        expect(unplaced.isError, JSON.stringify(unplaced.content)).toBe(false);
        expect(unplaced.structuredContent).toMatchObject({
          threadId: placedThere,
          environmentId: box.environmentId,
        });
        // So does one asking for a worktree only this checkout has.
        const local = yield* launchPlaced(a, {
          clientRequestId: "kept",
          workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: false },
        });
        expect(local.isError, JSON.stringify(local.content)).toBe(false);
        expect((local.structuredContent as { threadId: ThreadId }).threadId).toBe(placedThere);
        // Nothing here ever reached for a launch of its own.
        expect(yield* Ref.get(localLaunches)).toBe(0);
        expect(yield* Ref.get(thread.launched)).toBe(placedThere);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a launch whose answer was lost is never started again under a new link", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const tasks = () =>
        a.orchestrator.getThreadProjection(parentThreadId).pipe(Effect.map((p) => p.subagents));

      // The box starts the thread, but its answer is lost; then the box is linked again.
      yield* Ref.set(thread.afterLaunch, Effect.die("connection lost"));
      expect((yield* autoTask(a, "relinked")).isError).toBe(true);
      const lostThere = yield* Ref.get(thread.launched);
      expect(lostThere).not.toBeNull();
      yield* Ref.set(thread.afterLaunch, Effect.void);
      yield* linkTo(a.links, b, "full-access");
      // The new session would name a new thread there, so the retry starts nothing.
      const retried = yield* autoTask(a, "relinked");
      expect(retried.isError).toBe(true);
      expect(JSON.stringify(retried.content)).toContain("linked again");
      expect(yield* Ref.get(thread.launched)).toBe(lostThere);
      expect(yield* tasks()).toHaveLength(0);

      // A task already recorded is found again after a new link, without a second launch.
      const recorded = yield* autoTask(a, "recorded");
      expect(recorded.isError, JSON.stringify(recorded.content)).toBe(false);
      const recordedThere = yield* Ref.get(thread.launched);
      yield* linkTo(a.links, b, "full-access");
      const again = yield* autoTask(a, "recorded");
      expect(again.isError, JSON.stringify(again.content)).toBe(false);
      expect((again.structuredContent as { taskId: NodeId }).taskId).toBe(
        (recorded.structuredContent as { taskId: NodeId }).taskId,
      );
      expect(yield* Ref.get(thread.launched)).toBe(recordedThere);
      expect(yield* tasks()).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a link replaced between the launch check and the send starts no second child", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const relinkOnce = yield* Ref.make<Effect.Effect<void> | null>(null);
      const a = yield* makeLaptop(database, offers, undefined, Effect.void, {
        // The box is linked again after the launch is checked against its link, before it is sent.
        afterBindIntent: (commandId) =>
          commandId.includes(":remote-launch:")
            ? Ref.getAndSet(relinkOnce, null).pipe(
                Effect.flatMap((relink) => relink ?? Effect.void),
              )
            : Effect.void,
      });
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const tasks = () =>
        a.orchestrator.getThreadProjection(parentThreadId).pipe(Effect.map((p) => p.subagents));

      yield* Ref.set(thread.afterLaunch, Effect.die("connection lost"));
      expect((yield* autoTask(a, "raced")).isError).toBe(true);
      const lostThere = yield* Ref.get(thread.launched);
      expect(lostThere).not.toBeNull();
      yield* Ref.set(thread.afterLaunch, Effect.void);
      yield* Ref.set(
        relinkOnce,
        linkTo(a.links, b, "full-access").pipe(Effect.asVoid, Effect.orDie),
      );

      // The retry passes the check under the first link, but the send would use the new one.
      const raced = yield* autoTask(a, "raced");
      expect(raced.isError).toBe(true);
      expect(yield* Ref.get(thread.launched)).toBe(lostThere);
      expect(yield* tasks()).toHaveLength(0);
      // The key stays bound to the first link, so retrying it starts nothing either.
      expect((yield* autoTask(a, "raced")).isError).toBe(true);
      expect(yield* Ref.get(thread.launched)).toBe(lostThere);
      expect(yield* tasks()).toHaveLength(0);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a launch with no link to bind to starts nothing, even if a link appears", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const linkOnce = yield* Ref.make<Effect.Effect<void> | null>(null);
      const a = yield* makeLaptop(database, offers, undefined, Effect.void, {
        // The box is linked just after delegation finds no link to bind the launch to.
        afterSession: (session) =>
          Option.isNone(session)
            ? Ref.getAndSet(linkOnce, null).pipe(Effect.flatMap((link) => link ?? Effect.void))
            : Effect.void,
      });
      yield* seedParent(a);
      yield* Ref.set(linkOnce, linkTo(a.links, b, "full-access").pipe(Effect.asVoid, Effect.orDie));

      // A named project there means nothing reaches the box before the launch itself.
      const unbound = yield* a.call("delegate_task", {
        task: "Run the full suite on the box.",
        target: {
          environmentId: box.environmentId,
          projectId: boxProject,
          providerInstanceId: instanceId,
          model: "gpt-5.4",
        },
        clientRequestId: "unbound",
      });
      expect(unbound.isError).toBe(true);
      expect(yield* Ref.get(thread.launched)).toBeNull();
      expect((yield* a.orchestrator.getThreadProjection(parentThreadId)).subagents).toHaveLength(0);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("an auto-placed task runs at the parent's modes, never a narrower link's", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* seedParent(a, modelSelection, "plan");
      // The parent runs with full access; this link allows less, so the box is not eligible.
      yield* linkTo(a.links, b, "auto-accept-edits");
      const narrow = yield* autoTask(a, "narrow");
      expect(narrow.isError).toBe(true);
      expect(JSON.stringify(narrow.content)).toContain("no-eligible-environment");
      expect(yield* Ref.get(thread.launched)).toBeNull();

      yield* linkTo(a.links, b, "full-access");
      const wide = yield* autoTask(a, "wide");
      expect(wide.isError, JSON.stringify(wide.content)).toBe(false);
      expect(yield* Ref.get(thread.launchedWith)).toEqual({
        modelSelection: { instanceId: boxClaude.instanceId, model: "claude-sonnet-4-6" },
        runtimeMode: "full-access",
        interactionMode: "plan",
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("an auto-placed task refuses a project placement did not choose", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      // Placement qualifies the project with this repository, not another one there.
      const other = yield* autoTask(a, "other-project", {
        projectId: ProjectId.make("project:box-other-3"),
      });
      expect(other.isError).toBe(true);
      expect(JSON.stringify(other.content)).toContain("invalid_request");
      expect(yield* Ref.get(thread.launched)).toBeNull();
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("fails the task when the box revokes the link, and cancel interrupts it there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const cancelled = yield* delegateToBox(a);
      const cancel = yield* a.call("task_cancel", {
        taskId: cancelled.taskId,
        reason: "Not needed",
      });
      expect(cancel.structuredContent).toEqual({
        taskId: cancelled.taskId,
        status: "cancel_requested",
      });
      // Cancelling stops the thread there as Stop does: its queue and its own tasks too.
      expect(yield* Ref.get(thread.stops)).toEqual(["thread.stop", "delegated-tasks"]);
      expect(yield* taskResult(a, cancelled.taskId)).toMatchObject({ status: "cancelled" });

      // Cancelling again, once the result is in, still stops what came after it there.
      const again = yield* a.call("task_cancel", {
        taskId: cancelled.taskId,
        clientRequestId: "cancel-again",
      });
      expect(again.structuredContent).toEqual({ taskId: cancelled.taskId, status: "cancelled" });
      expect(yield* Ref.get(thread.interrupted)).toBe(2);
      // ...and a retry of that cancel stops nothing new.
      yield* a.call("task_cancel", { taskId: cancelled.taskId, clientRequestId: "cancel-again" });
      expect(yield* Ref.get(thread.interrupted)).toBe(2);

      // A second task, then the box revokes the link before it ends.
      const revoked = yield* a
        .call("delegate_task", {
          task: "Another one.",
          target: {
            environmentId: box.environmentId,
            providerInstanceId: instanceId,
            model: "gpt-5.4",
          },
          clientRequestId: "second",
        })
        .pipe(Effect.map((result) => result.structuredContent as { taskId: NodeId }));
      const [session] = yield* b.linkedSessions;
      yield* b.auth.revokeSession(session!.sessionId);
      yield* Deferred.succeed(thread.finished, undefined);
      const failed = yield* taskResult(a, revoked.taskId);
      expect(failed?.status).toBe("failed");
      expect(failed?.result).toBe(
        "The linked environment no longer accepts this link. It may have been revoked there; link it again.",
      );
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task's result is its own run's whole last reply, not a later run's", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const result = yield* a.call("delegate_task", {
        task: "Review the diff.",
        role: "review",
        target: { environmentId: box.environmentId },
        clientRequestId: "review-on-box",
      });
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
      const { taskId } = result.structuredContent as { taskId: NodeId };
      // The role reaches the thread there, as it does a child here.
      expect(yield* Ref.get(thread.message)).toBe(
        "Act as the review sub-agent for this task.\n\nReview the diff.",
      );

      // A reply longer than one read, then a later run's reply on the same thread.
      const long = "x".repeat(45_000);
      yield* Ref.set(thread.reply, long);
      yield* Ref.set(thread.laterReply, "Someone else asked a follow-up.");
      yield* Ref.set(thread.executedModel, "gpt-5.4-mini");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      const task = yield* taskResult(a, taskId);
      expect(task?.status).toBe("completed");
      expect(task?.result).toBe(
        `Requested model gpt-5.4; the provider reported running gpt-5.4-mini.\n\n${long}`,
      );
      const status = yield* a.call("task_status", { taskId });
      expect(status.structuredContent).toMatchObject({
        status: "completed",
        executedModel: "gpt-5.4-mini",
      });
      // Every wait was for the run the launch started.
      const waits = yield* Ref.get(thread.waitedFor);
      expect(waits.length).toBeGreaterThan(0);
      expect(waits.every((runId) => runId === boxRunId)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task whose thread there waits on its own task ends with the answer after it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);

      // The task's run there ends after delegating a review of its own.
      yield* Ref.set(thread.executedModel, "gpt-5.4-mini");
      yield* Ref.set(thread.nested, true);
      yield* Ref.set(thread.reply, "Started a review; I will answer when it reports.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      const first = yield* Effect.raceFirst(
        Deferred.await(thread.nestedWaiting).pipe(Effect.as("waiting there" as const)),
        taskResult(a, delegated.taskId).pipe(Effect.as("completed here" as const)),
      );
      expect(first).toBe("waiting there");

      // The review reports and wakes the thread there, whose next run answers.
      yield* Ref.set(thread.laterReply, "The review found two issues; both are fixed.");
      yield* Deferred.succeed(thread.nestedSettled, undefined);
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
        status: "completed",
        result: "The review found two issues; both are fixed.",
      });
      const status = yield* a.call("task_status", { taskId: delegated.taskId });
      expect(status.structuredContent).toMatchObject({
        status: "completed",
        executedModel: null,
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("the same key from another provider session is another task", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const first = yield* delegateToBox(a);
      const later = yield* a.call(
        "delegate_task",
        {
          task: "Run the full suite on the box.",
          target: { environmentId: box.environmentId },
          clientRequestId: "suite-on-box",
        },
        { ...parentScope, requestNamespace: "provider-session:laptop-parent-2" },
      );
      expect(later.isError, JSON.stringify(later.content)).toBe(false);
      const second = later.structuredContent as {
        taskId: NodeId;
        remoteChild: { threadId: ThreadId };
      };
      expect(second.taskId).not.toBe(first.taskId);
      expect(second.remoteChild.threadId).not.toBe(first.remoteChild.threadId);
      expect((yield* a.orchestrator.getThreadProjection(parentThreadId)).subagents).toHaveLength(2);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each([null, "Working before the provider failed."])(
  "reports the failed remote run's error instead of its earlier reply (%s)",
  (reply) =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);
        const delegated = yield* delegateToBox(a);
        yield* Ref.set(thread.reply, reply);
        const error = "Provider failed: authentication expired on the destination.";
        yield* Ref.set(thread.error, error);
        yield* Ref.set(thread.status, "failed");
        yield* Deferred.succeed(thread.finished, undefined);
        expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
          status: "failed",
          result: error,
        });
        const status = yield* a.call("task_status", { taskId: delegated.taskId });
        expect(status.structuredContent).toMatchObject({
          status: "failed",
          summary: error,
          latestTerminalSummary: error,
        });
        const offered = yield* SubscriptionRef.changes(offers).pipe(
          Stream.filter((seen) => seen.some((offer) => offer.threadId === parentThreadId)),
          Stream.runHead,
        );
        expect(Option.isSome(offered)).toBe(true);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each([false, true])(
  "ignores later-run errors and reads the failed run's full error (ownError=%s)",
  (ownError) =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);
        const delegated = yield* delegateToBox(a);
        yield* Ref.set(thread.reply, null);
        const error = `Provider failed: ${"detail ".repeat(10_000)}end of error.`;
        if (ownError) yield* Ref.set(thread.error, error);
        yield* Ref.set(thread.laterReply, "A later user run answered.");
        yield* Ref.set(thread.laterError, "Another run's provider error.");
        yield* Ref.set(thread.status, "failed");
        yield* Deferred.succeed(thread.finished, undefined);
        expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
          status: "failed",
          result: ownError
            ? error
            : "(The thread in the linked environment ended without a reply.)",
        });
        expect(yield* Ref.get(thread.waitedFor)).toEqual([boxRunId]);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("keeps a successful remote reply despite an error item in the run's activity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);
      yield* Ref.set(thread.reply, "Recovered and completed the task.");
      yield* Ref.set(thread.error, "A recoverable tool error.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
        status: "completed",
        result: "Recovered and completed the task.",
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("fails the task when its thread there is gone, or the link here is", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      yield* Ref.set(thread.gone, true);
      const gone = yield* delegateToBox(a);
      const failed = yield* taskResult(a, gone.taskId);
      expect(failed?.status).toBe("failed");
      expect(failed?.result).toContain("was not found");

      // The link is forgotten here while the task runs there.
      yield* Ref.set(thread.gone, false);
      const forgotten = yield* a
        .call("delegate_task", {
          task: "Another one.",
          target: { environmentId: box.environmentId },
          clientRequestId: "forgotten",
        })
        .pipe(Effect.map((result) => result.structuredContent as { taskId: NodeId }));
      yield* a.links.unlink(box.environmentId);
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      const unlinked = yield* taskResult(a, forgotten.taskId);
      expect(unlinked?.status).toBe("failed");
      expect(unlinked?.result).toContain("not linked to");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("cancel ends the task here even when the link is gone", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const delegated = yield* delegateToBox(a);
      yield* a.links.unlink(box.environmentId);
      const cancel = yield* a.call("task_cancel", { taskId: delegated.taskId });
      expect(cancel.structuredContent).toEqual({
        taskId: delegated.taskId,
        status: "cancel_requested",
      });
      const task = yield* taskResult(a, delegated.taskId);
      expect(task?.status).toBe("cancelled");
      expect(task?.result).toContain("could not be stopped in Box");
      expect(yield* Ref.get(thread.interrupted)).toBe(0);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a parent stopped while the task's result is read still stops its thread there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);

      // The task's run ends there, and while the follower reads its reply,
      // the parent here is stopped: more work may follow that run there.
      yield* Ref.set(thread.holdRead, true);
      yield* Ref.set(thread.reply, "Done there.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      yield* Deferred.await(thread.readStarted);
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent-mid-read"),
      });
      yield* Deferred.succeed(thread.releaseRead, undefined);

      // The Stop's result stands, and the thread there is still stopped.
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({ status: "interrupted" });
      yield* Deferred.await(thread.interruptedOnce);
      expect(yield* Ref.get(thread.stops)).toContain("thread.stop");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a stop the box refuses because the parent was lowered ends instead of retrying", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);

      // The parent is lowered below the full-access thread there, then stopped.
      yield* a.orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("command:lower:laptop-parent"),
        threadId: parentThreadId,
        runtimeMode: "approval-required",
      });
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent-lowered"),
      });

      // The box refuses that stop; the follower records it as settled and
      // stops, so nothing retries it, now or after a restart.
      const settled = yield* a.orchestrator
        .streamStoredEventsFrom({
          threadId: parentThreadId,
          afterSequence: 0,
          eventType: "subagent.updated",
        })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === delegated.taskId &&
              stored.event.payload.remoteChild?.stoppedThere === true,
          ),
          Stream.runHead,
        );
      expect(Option.isSome(settled)).toBe(true);
      expect(yield* Ref.get(thread.stops)).toEqual([]);
      expect(yield* a.projections.getOpenRemoteDelegatedTasks).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("stopping the parent stops its task there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const delegated = yield* delegateToBox(a);
      // What the delegated-tasks.stop effect runs once the parent's Stop commits.
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent"),
        reason: "User stopped",
      });
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
        status: "interrupted",
        result: "Stopped with its parent: User stopped",
      });
      // The follower sees it ended here and stops it there.
      yield* Deferred.await(thread.interruptedOnce);
      expect(yield* Ref.get(thread.interrupted)).toBe(1);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

/** A follower retry schedule the test steps: each failed attempt is offered, then waits for `retry`. */
const steppedRetries = Effect.gen(function* () {
  const failed = yield* Queue.unbounded<void>();
  const retry = yield* Queue.unbounded<void>();
  const schedule = Schedule.forever.pipe(
    Schedule.tap(() => Queue.offer(failed, undefined).pipe(Effect.andThen(Queue.take(retry)))),
  );
  return { failed, retry, schedule };
});

it.effect("a follower that keeps hitting defects fails the task and wakes the parent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const retries = yield* steppedRetries;
      const attempts = yield* Ref.make(0);
      // The defect carries internal detail that the task's result must not.
      const beforeFollow = Ref.update(attempts, (count) => count + 1).pipe(
        Effect.andThen(Effect.die(new Error("A follow attempt hit a bug: defect-detail-4f1c9e"))),
      );
      const a = yield* makeLaptop(database, offers, undefined, beforeFollow).pipe(
        Effect.provideService(RemoteDelegation.FollowRetrySchedule, retries.schedule),
      );
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      yield* Queue.take(retries.failed).pipe(
        Effect.andThen(Queue.offer(retries.retry, undefined)),
        Effect.forever,
        Effect.forkScoped,
      );

      const delegated = yield* delegateToBox(a);
      const task = yield* taskResult(a, delegated.taskId);
      expect(yield* Ref.get(attempts)).toBe(3);
      expect(task?.status).toBe("failed");
      expect(task?.result).toContain(delegated.remoteChild.threadId);
      expect(task?.result).not.toContain("defect-detail-4f1c9e");
      const offered = yield* SubscriptionRef.changes(offers).pipe(
        Stream.filter((seen) => seen.some((offer) => offer.threadId === parentThreadId)),
        Stream.runHead,
      );
      expect(Option.isSome(offered)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each(["a still-running wait", "a failed attempt"] as const)(
  "defects separated by %s do not add up to giving up",
  (between) =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const retries = yield* steppedRetries;
        const attempts = yield* Ref.make(0);
        const defect = Effect.die(new Error("A follow attempt hit a bug."));
        const script = [
          defect,
          between === "a still-running wait"
            ? Effect.void
            : Effect.fail(
                new Orchestrator.OrchestratorProjectionError({ threadId: parentThreadId }),
              ),
          defect,
          between === "a still-running wait"
            ? Effect.void
            : Effect.fail(
                new Orchestrator.OrchestratorProjectionError({ threadId: parentThreadId }),
              ),
          defect,
        ];
        // Past the script, the run there has ended, so the next attempt completes the task.
        const beforeFollow = Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
          Effect.flatMap(
            (count) =>
              script[count] ??
              Ref.set(thread.reply, "All green.").pipe(
                Effect.andThen(Ref.set(thread.status, "completed")),
              ),
          ),
        );
        // Each wait there answers at once that its run is still running.
        yield* Deferred.succeed(thread.finished, undefined);
        const a = yield* makeLaptop(database, offers, undefined, beforeFollow).pipe(
          Effect.provideService(RemoteDelegation.FollowRetrySchedule, retries.schedule),
        );
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);
        yield* Queue.take(retries.failed).pipe(
          Effect.andThen(Queue.offer(retries.retry, undefined)),
          Effect.forever,
          Effect.forkScoped,
        );

        const delegated = yield* delegateToBox(a);
        expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
          status: "completed",
          result: "All green.",
        });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

/** Waits until the task here records that the `stopCount`th Stop after its result reached there. */
const stoppedThere = (
  laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>,
  taskId: NodeId,
  // `null` for a cancel's stop, which carries no count.
  stopCount: number | null = 1,
) =>
  laptopEnv.orchestrator
    .streamStoredEventsFrom({
      threadId: parentThreadId,
      afterSequence: 0,
      eventType: "subagent.updated",
    })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "subagent.updated" &&
          stored.event.payload.id === taskId &&
          stored.event.payload.remoteChild?.stoppedThere === true &&
          stored.event.payload.remoteChild.stopCount === (stopCount ?? undefined),
      ),
      Stream.runHead,
      Effect.map((stored) =>
        Option.isSome(stored) && stored.value.event.type === "subagent.updated"
          ? stored.value.event.payload
          : undefined,
      ),
    );

it.effect("a follower that keeps hitting defects leaves a stop it owes owed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const retries = yield* steppedRetries;
      // Follow attempts hit a defect only once the task has its result.
      const broken = yield* Ref.make(false);
      const follower = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      const beforeFollow = Ref.get(broken).pipe(
        Effect.flatMap((isBroken) =>
          isBroken
            ? Effect.withFiber((fiber) => Deferred.succeed(follower, fiber)).pipe(
                Effect.andThen(Effect.die(new Error("A follow attempt hit a bug."))),
              )
            : Effect.void,
        ),
      );
      const a = yield* makeLaptop(database, offers, undefined, beforeFollow).pipe(
        Effect.provideService(RemoteDelegation.FollowRetrySchedule, retries.schedule),
      );
      yield* a.remote.start();
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);
      yield* Ref.set(thread.reply, "All green.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      yield* taskResult(a, delegated.taskId);
      yield* Ref.set(broken, true);
      yield* Queue.take(retries.failed).pipe(
        Effect.andThen(Queue.offer(retries.retry, undefined)),
        Effect.forever,
        Effect.forkScoped,
      );

      // The Stop owes one stop there, which every attempt to send fails on.
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent-defective-follower"),
      });
      const owedAgain = a.orchestrator
        .streamStoredEventsFrom({
          threadId: parentThreadId,
          afterSequence: 0,
          eventType: "subagent.updated",
        })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === delegated.taskId &&
              (stored.event.payload.remoteChild?.stopCount ?? 0) > 1,
          ),
          Stream.runHead,
          Effect.flatMap((owed) =>
            Option.isSome(owed) ? Effect.succeed("owed another stop" as const) : Effect.never,
          ),
        );
      const ended = yield* Deferred.await(follower).pipe(
        Effect.flatMap(Fiber.await),
        Effect.as("follower ended" as const),
        Effect.raceFirst(owedAgain),
      );
      expect(ended).toBe("follower ended");
      const { subagents } = yield* a.threads.getThreadRecords(parentThreadId, ["subagents"], {
        subagentIds: [delegated.taskId],
      });
      expect(subagents[0]).toMatchObject({
        status: "completed",
        result: "All green.",
        remoteChild: { stoppedThere: false, stopCount: 1 },
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("stopping the parent stops follow-up work on a task there that has its result", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* a.remote.start();
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);
      yield* Ref.set(thread.reply, "All green.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
        status: "completed",
        result: "All green.",
      });

      // The parent sends the thread there a follow-up, which starts a run there as a new task.
      const sent = yield* a.call("t3_thread_send", {
        environmentId: box.environmentId,
        threadId: delegated.remoteChild.threadId,
        message: "Now run the slow suite too.",
      });
      expect(sent.isError, JSON.stringify(sent.content)).toBe(false);
      const followUpId = (sent.structuredContent as { taskId: NodeId }).taskId;
      expect(yield* Ref.get(thread.sent)).toEqual(["Now run the slow suite too."]);
      expect(yield* Ref.get(thread.interrupted)).toBe(0);

      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent-after-result"),
      });
      // The thread there is stopped as Stop does, for each task, and the first keeps its result.
      const task = yield* stoppedThere(a, delegated.taskId);
      expect(yield* stoppedThere(a, followUpId, null)).toMatchObject({ status: "interrupted" });
      expect((yield* Ref.get(thread.stops)).toSorted()).toEqual([
        "delegated-tasks",
        "delegated-tasks",
        "thread.stop",
        "thread.stop",
      ]);
      expect(task).toMatchObject({ status: "completed", result: "All green." });
      expect(yield* a.projections.getOpenRemoteDelegatedTasks).toEqual([]);

      // A second Stop owes a second stop there, not a replay of the first.
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent-again"),
      });
      expect(yield* stoppedThere(a, delegated.taskId, 2)).toMatchObject({ status: "completed" });
      expect(yield* stoppedThere(a, followUpId, 1)).toMatchObject({ status: "interrupted" });
      expect(yield* Ref.get(thread.interrupted)).toBe(4);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each([
  { order: "sent", queuedFirst: false },
  // Concurrent sends may be recorded here in the opposite order they run there.
  { order: "recorded out of order", queuedFirst: true },
])(
  "a follow-up there ends with its own reply, not one queued behind it ($order)",
  ({ queuedFirst }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* a.remote.start();
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);
        const delegated = yield* delegateToBox(a);
        yield* Ref.set(thread.reply, "All green.");
        yield* Ref.set(thread.status, "completed");
        yield* Deferred.succeed(thread.finished, undefined);
        yield* taskResult(a, delegated.taskId);

        const sendFollowUp = a.call("t3_thread_send", {
          environmentId: box.environmentId,
          threadId: delegated.remoteChild.threadId,
          message: "Now run the slow suite too.",
        });
        const sendQueued = a.call("t3_thread_send", {
          environmentId: box.environmentId,
          threadId: delegated.remoteChild.threadId,
          message: "Then the flaky suite.",
          mode: "queue",
        });
        const [first, second] = queuedFirst
          ? [sendQueued, sendFollowUp]
          : [sendFollowUp, sendQueued];
        const firstSent = yield* first;
        yield* TestClock.adjust("1 second");
        const secondSent = yield* second;
        const [followUp, queued] = queuedFirst ? [secondSent, firstSent] : [firstSent, secondSent];
        const followUpId = (followUp.structuredContent as { taskId: NodeId }).taskId;
        expect((queued.structuredContent as { taskId?: NodeId }).taskId).toBeDefined();

        // The thread there settles on the queued run, after the follow-up's own run ended.
        yield* Ref.set(thread.laterReply, "The slow suite passes too.");
        yield* Ref.set(thread.queuedReply, "The flaky suite passes.");
        yield* Deferred.succeed(thread.laterFinished, undefined);
        expect(yield* taskResult(a, followUpId)).toMatchObject({
          status: "completed",
          result: "The slow suite passes too.",
        });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each([
  {
    restarted: "follow-up",
    of: boxLaterRunId,
    laterReply: "Running the slow suite…",
    restartReply: "The slow suite passes too.",
    queuedReply: "The flaky suite passes.",
  },
  {
    restarted: "queued",
    of: boxQueuedRunId,
    laterReply: "The slow suite passes too.",
    restartReply: "The flaky suite passes.",
    queuedReply: "Running the flaky suite…",
  },
])(
  "a follow-up there ends with its own reply when the $restarted run is restarted",
  ({ of, laterReply, restartReply, queuedReply }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const a = yield* makeLaptop(database, offers);
        yield* a.remote.start();
        yield* linkTo(a.links, b, "full-access");
        yield* seedParent(a);
        const delegated = yield* delegateToBox(a);
        yield* Ref.set(thread.reply, "All green.");
        yield* Ref.set(thread.status, "completed");
        yield* Deferred.succeed(thread.finished, undefined);
        yield* taskResult(a, delegated.taskId);

        const followUp = yield* a.call("t3_thread_send", {
          environmentId: box.environmentId,
          threadId: delegated.remoteChild.threadId,
          message: "Now run the slow suite too.",
        });
        yield* a.call("t3_thread_send", {
          environmentId: box.environmentId,
          threadId: delegated.remoteChild.threadId,
          message: "Then the flaky suite.",
          mode: "queue",
        });
        const followUpId = (followUp.structuredContent as { taskId: NodeId }).taskId;

        // The thread there settles on the queued run, after one of the two was restarted.
        yield* Ref.set(thread.laterReply, laterReply);
        yield* Ref.set(thread.queuedReply, queuedReply);
        yield* Ref.set(thread.restart, { of, reply: restartReply });
        yield* Deferred.succeed(thread.laterFinished, undefined);
        expect(yield* taskResult(a, followUpId)).toMatchObject({
          status: "completed",
          result: "The slow suite passes too.",
        });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a follow-up sent after the parent's own run ended is still a task", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* a.remote.start();
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);
      yield* Ref.set(thread.reply, "All green.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      yield* taskResult(a, delegated.taskId);

      // The parent's turn ends, while a background agent of its own still holds its credential.
      const now = yield* DateTime.now;
      const projection = yield* a.orchestrator.getThreadProjection(parentThreadId);
      const run = projection.runs.find((candidate) => candidate.id === parentRunId)!;
      yield* a.sink.write({
        commandId: CommandId.make("command:seed:laptop-parent-ended"),
        events: [
          {
            id: EventId.make("event:seed-background-agent:laptop-parent"),
            type: "provider-thread.updated",
            threadId: parentThreadId,
            driver,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: {
              ...projection.providerThreads[0]!,
              pendingBackgroundTasks: [{ taskId: "native-agent", kind: "subagent" }],
              updatedAt: now,
            },
          },
          {
            id: EventId.make("event:seed-run-ended:laptop-parent"),
            type: "run.updated",
            threadId: parentThreadId,
            runId: parentRunId,
            nodeId: parentRootNode,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });

      const sent = yield* a.call("t3_thread_send", {
        environmentId: box.environmentId,
        threadId: delegated.remoteChild.threadId,
        message: "Now run the slow suite too.",
      });
      expect(sent.isError, JSON.stringify(sent.content)).toBe(false);
      const followUp = sent.structuredContent as { taskId?: NodeId };
      expect(followUp.taskId, JSON.stringify(followUp)).toBeDefined();
      const tasks = (yield* a.orchestrator.getThreadProjection(parentThreadId)).subagents;
      expect(tasks.find((task) => task.id === followUp.taskId)).toMatchObject({
        runId: parentRunId,
        status: "running",
      });

      // Its run there ends with its own reply, and the parent wakes for it.
      const wakes = (
        seen: ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>,
      ) => seen.filter((offer) => offer.threadId === parentThreadId).length;
      const wokenBefore = wakes(yield* SubscriptionRef.get(offers));
      yield* Ref.set(thread.laterReply, "The slow suite passes too.");
      yield* Deferred.succeed(thread.laterFinished, undefined);
      expect(yield* taskResult(a, followUp.taskId!)).toMatchObject({
        status: "completed",
        result: "The slow suite passes too.",
      });
      const offered = yield* SubscriptionRef.changes(offers).pipe(
        Stream.filter((seen) => wakes(seen) > wokenBefore),
        Stream.runHead,
      );
      expect(Option.isSome(offered)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a delayed Stop acknowledgement leaves a newer Stop owed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* a.remote.start();
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);
      yield* Ref.set(thread.reply, "All green.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      yield* taskResult(a, delegated.taskId);

      yield* Ref.set(thread.holdFirstStop, true);
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:delayed-first"),
      });
      yield* Deferred.await(thread.stopStarted);
      // Work starts after the first Stop landed there, but before its acknowledgement returns.
      const sent = yield* a.call("t3_thread_send", {
        environmentId: box.environmentId,
        threadId: delegated.remoteChild.threadId,
        message: "Run another check.",
      });
      const followUpId = (sent.structuredContent as { taskId: NodeId }).taskId;
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:delayed-second"),
      });
      const pending = yield* a.threads.getThreadRecords(parentThreadId, ["subagents"]);
      expect(
        pending.subagents.find((task) => task.id === delegated.taskId)?.remoteChild,
      ).toMatchObject({ stoppedThere: false, stopCount: 2 });
      yield* Deferred.succeed(thread.releaseStop, undefined);
      expect(yield* stoppedThere(a, delegated.taskId, 2)).toMatchObject({
        status: "completed",
        result: "All green.",
      });
      // The follow-up the work became is stopped there too, as its own task.
      expect(yield* stoppedThere(a, followUpId, null)).toMatchObject({ status: "interrupted" });
      expect(yield* Ref.get(thread.interrupted)).toBe(3);
      expect(yield* a.projections.getOpenRemoteDelegatedTasks).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a Stop on a task that has its result reaches there after a restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
      // The laptop records the Stop, then goes away before its follower sends it.
      const delegated = yield* Effect.scoped(
        Effect.gen(function* () {
          const before = yield* makeLaptop(database, offers, linking);
          yield* linkTo(before.links, b, "full-access");
          yield* seedParent(before);
          const task = yield* delegateToBox(before);
          yield* Ref.set(thread.status, "completed");
          yield* Deferred.succeed(thread.finished, undefined);
          yield* taskResult(before, task.taskId);
          yield* before.threads.stopDelegatedTasks({
            threadId: parentThreadId,
            commandId: CommandId.make("command:stop:laptop-parent-before-restart"),
          });
          return task;
        }),
      );
      expect(yield* Ref.get(thread.interrupted)).toBe(0);

      const after = yield* makeLaptop(database, offers, linking);
      expect(yield* after.projections.getOpenRemoteDelegatedTasks).toEqual([
        { parentThreadId, taskId: delegated.taskId },
      ]);
      yield* after.remote.start();
      expect(yield* stoppedThere(after, delegated.taskId)).toMatchObject({ status: "completed" });
      expect(yield* Ref.get(thread.stops)).toEqual(["thread.stop", "delegated-tasks"]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a parent stopped while the box is unreachable still stops its task there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const retries = yield* steppedRetries;
      const a = yield* makeLaptop(database, offers).pipe(
        Effect.provideService(RemoteDelegation.FollowRetrySchedule, retries.schedule),
      );
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      // The box sleeps as soon as the task is there, so its follower's first attempt fails.
      yield* Ref.set(
        thread.afterLaunch,
        Ref.set(b.descriptor, descriptorOf("environment-elsewhere", "Elsewhere")),
      );
      const delegated = yield* delegateToBox(a);
      yield* Queue.take(retries.failed);
      // The parent is stopped meanwhile.
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent-offline"),
      });
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({ status: "interrupted" });

      // Once the box is back, the follower's next attempt stops the task there.
      yield* Ref.set(b.descriptor, box);
      yield* Queue.offer(retries.retry, undefined);
      yield* Deferred.await(thread.interruptedOnce);
      expect(yield* Ref.get(thread.interrupted)).toBe(1);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task cancelled while the box is unreachable is stopped there after a restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      // Its links outlive the restart, so the box knows it as the same link session.
      const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
      // The laptop cancels while the box sleeps, then restarts before it wakes.
      const delegated = yield* Effect.scoped(
        Effect.gen(function* () {
          const before = yield* makeLaptop(database, offers, linking);
          yield* linkTo(before.links, b, "full-access");
          yield* seedParent(before);
          const task = yield* delegateToBox(before);
          yield* Ref.set(b.descriptor, descriptorOf("environment-elsewhere", "Elsewhere"));
          yield* before.call("task_cancel", { taskId: task.taskId });
          expect(yield* taskResult(before, task.taskId)).toMatchObject({ status: "cancelled" });
          return task;
        }),
      );
      expect(yield* Ref.get(thread.interrupted)).toBe(0);

      yield* Ref.set(b.descriptor, box);
      const after = yield* makeLaptop(database, offers, linking);
      yield* after.remote.start();
      yield* Deferred.await(thread.interruptedOnce);
      // Once the stop is recorded, nothing is owed there any more.
      yield* stoppedThere(after, delegated.taskId, null);
      expect(yield* after.projections.getOpenRemoteDelegatedTasks).toEqual([]);
      expect(yield* Ref.get(thread.stops)).toEqual(["thread.stop", "delegated-tasks"]);
      // The result here is still the cancel's.
      expect(yield* taskResult(after, delegated.taskId)).toMatchObject({ status: "cancelled" });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task whose thread there has no run ends with its last reply", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      // As a task recorded before its run was kept, whose thread there is idle.
      yield* Ref.set(thread.runless, true);
      yield* Ref.set(thread.reply, "Done before it was followed.");

      const delegated = yield* delegateToBox(a);
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
        status: "completed",
        result: "Done before it was followed.",
      });
      // One look, not a loop.
      expect(yield* Ref.get(thread.waitedFor)).toEqual([undefined]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a local task runs in this thread's project", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* seedParent(a);

      const result = yield* a.call("delegate_task", {
        task: "Run it here.",
        target: { projectId: "project:elsewhere" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("invalid_request");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

/** A native client's new-thread launch, admitted on the laptop for the box's Claude model. */
const nativeAdmission = (
  laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>,
  options: {
    readonly commandId: string;
    readonly sessionId?: string;
    readonly stillAuthorized?: Effect.Effect<boolean>;
    readonly model?: string;
    readonly here?: Effect.Effect<
      { readonly resources: HostResourcesSnapshot | null; readonly modelAvailable: boolean },
      OrchestrationV2ThreadPlacementAdmitError
    >;
  },
) =>
  laptopEnv.remote
    .admit(
      {
        sessionId: options.sessionId ?? "web-session",
        stillAuthorized: options.stillAuthorized ?? Effect.succeed(true),
      },
      {
        commandId: CommandId.make(options.commandId),
        threadId: ThreadId.make(`thread:${options.commandId}`),
        projectId: laptopProject.id,
        modelSelection: {
          instanceId: boxClaude.instanceId,
          model: options.model ?? "claude-sonnet-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        candidateEnvironmentIds: [laptop.environmentId, box.environmentId],
        // The laptop cannot run the model, so only the box can take it.
        here: options.here ?? Effect.succeed({ resources: loadOf(0.1), modelAvailable: false }),
      },
    )
    .pipe(Effect.result);

const nativePlacementBinding = (commandId: string) =>
  CommandId.make(
    `command:native:${encodeURIComponent(laptop.environmentId)}:placement:thread-launch:${encodeURIComponent(commandId)}`,
  );

it.effect(
  "a native launch is bound to the box with its session, and only that session resumes it, as bound",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const laptopEnv = yield* makeLaptop(database, offers);
        yield* linkTo(laptopEnv.links, b, "full-access");

        const admitted = yield* nativeAdmission(laptopEnv, { commandId: "web-launch" });
        expect(admitted).toEqual(
          Result.succeed({
            environmentId: box.environmentId,
            projectId: boxProject,
            reason: "capacity",
            resumed: false,
          }),
        );
        // Admission sends no launch: the client launches there over its own connection.
        expect(yield* Ref.get(thread.launched)).toBeNull();

        // The box fills up and the request changes; this machine's evidence cannot even be read.
        // Its binding still holds for the session that made it, without reading any of that.
        yield* Ref.set(thread.resources, loadOf(0.99));
        const hereRead = yield* Ref.make(0);
        const resumed = yield* nativeAdmission(laptopEnv, {
          commandId: "web-launch",
          model: "a-model-nowhere",
          here: Ref.update(hereRead, (count) => count + 1).pipe(
            Effect.andThen(
              Effect.fail(
                new OrchestrationV2ThreadPlacementAdmitError({
                  commandId: CommandId.make("web-launch"),
                  reason: "unavailable",
                  detail: "providers unreadable",
                }),
              ),
            ),
          ),
        });
        expect(resumed).toEqual(
          Result.succeed({
            environmentId: box.environmentId,
            projectId: boxProject,
            reason: "capacity",
            resumed: true,
          }),
        );
        expect(yield* Ref.get(hereRead)).toBe(0);

        // Another sign-in neither adopts it nor starts it afresh.
        const other = yield* nativeAdmission(laptopEnv, {
          commandId: "web-launch",
          sessionId: "replaced-session",
        });
        expect(Result.isFailure(other) && other.failure.reason).toBe("other-session");

        // A session no longer signed in binds nothing, so nothing of it stays to be adopted.
        yield* Ref.set(thread.resources, loadOf(0.1));
        const signedOut = yield* nativeAdmission(laptopEnv, {
          commandId: "signed-out",
          stillAuthorized: Effect.succeed(false),
        });
        expect(Result.isFailure(signedOut) && signedOut.failure.reason).toBe("unavailable");
        const later = yield* nativeAdmission(laptopEnv, {
          commandId: "signed-out",
          sessionId: "another-session",
        });
        expect(Result.isSuccess(later)).toBe(true);

        // Signed out while the machines were asked: the choice is not bound.
        const checks = yield* Ref.make(0);
        const revokedMidway = yield* nativeAdmission(laptopEnv, {
          commandId: "revoked-midway",
          stillAuthorized: Ref.updateAndGet(checks, (count) => count + 1).pipe(
            Effect.map((count) => count === 1),
          ),
        });
        expect(Result.isFailure(revokedMidway) && revokedMidway.failure.reason).toBe("unavailable");
        expect(yield* Ref.get(checks)).toBe(2);
        expect(yield* laptopEnv.threads.intentOf(nativePlacementBinding("revoked-midway"))).toEqual(
          Option.none(),
        );
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "automatic placement never contacts an excluded machine, and refuses a launch bound to one",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const laptopEnv = yield* makeLaptop(database, offers);
        yield* linkTo(laptopEnv.links, b, "full-access");
        // Bound before the box is excluded: both the native and the MCP operations.
        expect(
          Result.isSuccess(yield* nativeAdmission(laptopEnv, { commandId: "bound-before" })),
        ).toBe(true);
        const placeHere = (key: string, here = { resources: loadOf(0.1), modelAvailable: false }) =>
          laptopEnv.remote
            .place(outsideScope, {
              operation: "thread-launch",
              key,
              threadId: ThreadId.make(`thread:${key}`),
              projectId: laptopProject.id,
              modelSelection: { instanceId: boxClaude.instanceId, model: "claude-sonnet-4-6" },
              runtimeMode: "full-access",
              here,
            })
            .pipe(Effect.result);
        expect(yield* placeHere("mcp-bound-before")).toEqual(Result.succeed(box.environmentId));

        yield* laptopEnv.settings.updateSettings({
          automaticPlacementExcludedEnvironmentIds: [box.environmentId],
        });
        const contact = Effect.all([Ref.get(b.probes), Ref.get(b.bearers)]);
        const before = yield* contact;

        // The box still answers with room to spare, yet nobody asks it: this machine is chosen.
        const native = yield* nativeAdmission(laptopEnv, {
          commandId: "fresh",
          here: Effect.succeed({ resources: loadOf(0.5), modelAvailable: true }),
        });
        expect(Result.isSuccess(native) && native.success.environmentId).toBe(laptop.environmentId);
        expect(
          yield* placeHere("mcp-fresh", { resources: loadOf(0.5), modelAvailable: true }),
        ).toEqual(Result.succeed(laptop.environmentId));

        // Work bound there earlier is refused, never rescored elsewhere or sent there.
        const boundNative = yield* nativeAdmission(laptopEnv, { commandId: "bound-before" });
        expect(Result.isFailure(boundNative) && boundNative.failure.reason).toBe("excluded");
        const boundMcp = yield* placeHere("mcp-bound-before");
        expect(Result.isFailure(boundMcp) && boundMcp.failure.code).toBe("target_required");
        // An excluded machine alone leaves nowhere eligible.
        const nowhere = yield* nativeAdmission(laptopEnv, { commandId: "nowhere" });
        expect(Result.isFailure(nowhere) && nowhere.failure.reason).toBe("no-eligible-environment");

        expect(yield* contact).toEqual(before);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "PR74-R1-F1: a launch admitted here, then excluded, is refused unless it was launched here",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const laptopEnv = yield* makeLaptop(database, offers);
        yield* linkTo(laptopEnv.links, b, "full-access");
        yield* seedParent(laptopEnv);
        // The box is full, so this machine is chosen: admission only, nothing launched here.
        yield* Ref.set(thread.resources, loadOf(0.99));
        const runsHere = Effect.succeed({ resources: loadOf(0.1), modelAvailable: true });
        const admitHere = (commandId: string, threadId?: ThreadId) =>
          laptopEnv.remote
            .admit(
              { sessionId: "web-session", stillAuthorized: Effect.succeed(true) },
              {
                commandId: CommandId.make(commandId),
                threadId: threadId ?? ThreadId.make(`thread:${commandId}`),
                projectId: laptopProject.id,
                modelSelection: { instanceId: boxClaude.instanceId, model: "claude-sonnet-4-6" },
                runtimeMode: "full-access",
                interactionMode: "default",
                candidateEnvironmentIds: [laptop.environmentId, box.environmentId],
                here: runsHere,
              },
            )
            .pipe(Effect.result);
        const placeHere = (key: string) =>
          laptopEnv.remote
            .place(outsideScope, {
              operation: "thread-launch",
              key,
              threadId: ThreadId.make(`thread:${key}`),
              projectId: laptopProject.id,
              modelSelection: { instanceId: boxClaude.instanceId, model: "claude-sonnet-4-6" },
              runtimeMode: "full-access",
              here: { resources: loadOf(0.1), modelAvailable: true },
            })
            .pipe(Effect.result);
        const pending = yield* admitHere("local-pending");
        expect(Result.isSuccess(pending) && pending.success.environmentId).toBe(
          laptop.environmentId,
        );
        // Admitted here, then actually launched here as itself: `thread.create` under the same
        // command id for the same thread, through the real orchestrator and its receipt.
        const acceptedThread = ThreadId.make("thread:local-accepted");
        const accepted = yield* admitHere("local-accepted", acceptedThread);
        expect(Result.isSuccess(accepted) && accepted.success.environmentId).toBe(
          laptop.environmentId,
        );
        const launched = yield* laptopEnv.orchestrator
          .dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("local-accepted"),
            threadId: acceptedThread,
            projectId: ProjectId.make("project:laptop"),
            title: "Placed here",
            modelSelection: { instanceId: boxClaude.instanceId, model: "claude-sonnet-4-6" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          })
          .pipe(Effect.result);
        expect(Result.isSuccess(launched)).toBe(true);
        expect(yield* placeHere("mcp-local-pending")).toEqual(Result.succeed(laptop.environmentId));

        yield* laptopEnv.settings.updateSettings({
          automaticPlacementExcludedEnvironmentIds: [laptop.environmentId],
        });
        // Not launched yet: refused, its binding kept as it was, never placed again.
        const refused = yield* admitHere("local-pending");
        expect(Result.isFailure(refused) && refused.failure.reason).toBe("excluded");
        const refusedMcp = yield* placeHere("mcp-local-pending");
        expect(Result.isFailure(refusedMcp) && refusedMcp.failure.code).toBe("target_required");
        yield* laptopEnv.settings.updateSettings({ automaticPlacementExcludedEnvironmentIds: [] });
        const kept = yield* admitHere("local-pending");
        expect(Result.isSuccess(kept) && kept.success).toMatchObject({
          environmentId: laptop.environmentId,
          resumed: true,
        });
        // Launched here already: that exact accepted result still reconciles past the exclusion.
        yield* laptopEnv.settings.updateSettings({
          automaticPlacementExcludedEnvironmentIds: [laptop.environmentId],
        });
        const replayed = yield* admitHere("local-accepted", acceptedThread);
        expect(Result.isSuccess(replayed) && replayed.success).toMatchObject({
          environmentId: laptop.environmentId,
          resumed: true,
        });
        // Named with an unrelated thread that exists here, the same command proves nothing.
        const unrelated = yield* admitHere("local-accepted", parentThreadId);
        expect(Result.isFailure(unrelated) && unrelated.failure.reason).toBe("excluded");
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "PR74-R1-F1: only this command's own accepted launch here reconciles past a current exclusion",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* makeBoxThread;
        const b = yield* serveBox(thread);
        const offers = yield* SubscriptionRef.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
        const laptopEnv = yield* makeLaptop(database, offers);
        yield* linkTo(laptopEnv.links, b, "full-access");
        yield* seedParent(laptopEnv);
        yield* Ref.set(thread.resources, loadOf(0.99));
        const admit = (commandId: string, threadId: ThreadId) =>
          laptopEnv.remote
            .admit(
              { sessionId: "web-session", stillAuthorized: Effect.succeed(true) },
              {
                commandId: CommandId.make(commandId),
                threadId,
                projectId: laptopProject.id,
                modelSelection: { instanceId: boxClaude.instanceId, model: "claude-sonnet-4-6" },
                runtimeMode: "full-access",
                interactionMode: "default",
                candidateEnvironmentIds: [laptop.environmentId, box.environmentId],
                here: Effect.succeed({ resources: loadOf(0.1), modelAvailable: true }),
              },
            )
            .pipe(Effect.result);
        // The launch a native client sends here for an admitted operation: `thread.create` under
        // the operation's own command id, through the real orchestrator and its receipt.
        const launchHere = (commandId: string, threadId: ThreadId) =>
          laptopEnv.orchestrator
            .dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(commandId),
              threadId,
              projectId: ProjectId.make("project:laptop"),
              title: "Placed here",
              modelSelection: { instanceId: boxClaude.instanceId, model: "claude-sonnet-4-6" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            })
            .pipe(Effect.result);
        const pendingThread = ThreadId.make("thread:pending");
        const acceptedThread = ThreadId.make("thread:accepted");
        const typedThread = ThreadId.make("thread:other-type");
        for (const [commandId, threadId] of [
          ["pending", pendingThread],
          ["accepted", acceptedThread],
          ["rejected", parentThreadId],
          ["other-type", typedThread],
        ] as const) {
          const admitted = yield* admit(commandId, threadId);
          expect(Result.isSuccess(admitted) && admitted.success.environmentId).toBe(
            laptop.environmentId,
          );
        }
        // `accepted` is launched here as itself; `rejected`'s launch is refused (its thread exists
        // already); `other-type` has only a receipt of another kind under its command id.
        expect(Result.isSuccess(yield* launchHere("accepted", acceptedThread))).toBe(true);
        expect(Result.isFailure(yield* launchHere("rejected", parentThreadId))).toBe(true);
        yield* laptopEnv.threads.bindIntent({
          commandId: CommandId.make("other-type"),
          threadId: typedThread,
          value: "not a launch",
        });

        yield* laptopEnv.settings.updateSettings({
          automaticPlacementExcludedEnvironmentIds: [laptop.environmentId],
        });
        const contact = Effect.all([Ref.get(b.probes), Ref.get(b.bearers)]);
        const before = yield* contact;
        const reason = (result: Effect.Success<ReturnType<typeof admit>>) =>
          Result.isFailure(result) ? result.failure.reason : "admitted";
        // Never launched, retried naming an unrelated thread that exists here.
        expect(reason(yield* admit("pending", parentThreadId))).toBe("excluded");
        // Never launched, retried as admitted.
        expect(reason(yield* admit("pending", pendingThread))).toBe("excluded");
        // Its launch here was refused, though its thread exists.
        expect(reason(yield* admit("rejected", parentThreadId))).toBe("excluded");
        // A receipt under its id that is not an accepted launch.
        expect(reason(yield* admit("other-type", typedThread))).toBe("excluded");
        // Its own accepted launch, but retried for another thread.
        expect(reason(yield* admit("accepted", parentThreadId))).toBe("excluded");
        // Its own accepted launch of its own thread: that result reconciles, as bound.
        const replayed = yield* admit("accepted", acceptedThread);
        expect(Result.isSuccess(replayed) && replayed.success).toMatchObject({
          environmentId: laptop.environmentId,
          resumed: true,
        });
        // Nothing was asked of the box meanwhile, and nothing was rebound or rescored.
        expect(yield* contact).toEqual(before);
        yield* laptopEnv.settings.updateSettings({ automaticPlacementExcludedEnvironmentIds: [] });
        const kept = yield* admit("pending", pendingThread);
        expect(Result.isSuccess(kept) && kept.success).toMatchObject({
          environmentId: laptop.environmentId,
          resumed: true,
        });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
