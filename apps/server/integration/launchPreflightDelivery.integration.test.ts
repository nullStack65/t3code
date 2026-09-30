// @effect-diagnostics nodeBuiltinImport:off - a real temporary workspace exercises the launch path.
import {
  CommandId,
  GrokSettings,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../src/config.ts";
import * as LaunchPreflight from "../src/environment/LaunchPreflight.ts";
import { LaunchPreflightWarningInbox } from "../src/environment/LaunchPreflightWarningInbox.ts";
import { makeLaunchPreflightWarningReporter } from "../src/environment/launchPreflightReporter.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../src/orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../src/persistence/ProviderSessionRuntime.ts";
import * as RepositoryIdentityResolver from "../src/project/RepositoryIdentityResolver.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { makeGrokAdapter } from "../src/provider/Layers/GrokAdapter.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../src/provider/Layers/ProviderEventLoggers.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import { ProviderAdapterProcessError } from "../src/provider/Errors.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../src/provider/Services/ProviderService.ts";
import { makeAdapterRegistryMock } from "../src/provider/testUtils/providerAdapterRegistryMock.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { execScriptSource, writeFakeCli } from "../src/testUtils/fakeCli.ts";
import { AnalyticsService } from "../src/telemetry/AnalyticsService.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";
import { makeTestProviderAdapterHarness } from "./TestProviderAdapter.integration.ts";

const codexInstanceId = ProviderInstanceId.make("codex");
const grokInstanceId = ProviderInstanceId.make("grok");
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const findingResult = (
  findings: ReadonlyArray<LaunchPreflight.LaunchPreflightFinding>,
): LaunchPreflight.LaunchPreflightResult => ({
  findings,
  warnings: findings.filter((finding) => finding.severity === "warning"),
  blockers: findings.filter((finding) => finding.severity === "blocker"),
});

/**
 * The real orchestration engine the production reporter dispatches into. Its
 * domain-event stream is exactly what a client subscribes to.
 */
const orchestrationEngineLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-a3-engine-" })),
  Layer.provideMerge(NodeServices.layer),
);

const makeWorkspaceDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectory();
  yield* fs.writeFileString(pathService.join(cwd, "README.md"), "v1\n");
  return cwd;
}).pipe(Effect.provide(NodeServices.layer));

it.live(
  "A3: the production reporter delivers a real pre-thread warning through the real subscription",
  () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorkspaceDirectory;
      yield* Effect.promise(async () => {
        NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd });
      });

      // A real preflight finding before any thread exists: the workspace is a
      // Git repository and is explicitly configured as the shared session root,
      // so the real bounded probe reports an unexpected umbrella repository.
      const early = yield* Effect.gen(function* () {
        const preflight = yield* LaunchPreflight.LaunchPreflight;
        return yield* preflight.run(cwd, { isSharedRoot: true });
      }).pipe(
        Effect.provide(
          LaunchPreflight.layer.pipe(
            Layer.provide(VcsProcess.layer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      assert.deepStrictEqual(
        early.findings.map((finding) => finding.code),
        ["shared-root-git"],
      );
      const earlyMessage = early.warnings[0]?.message ?? "";
      assert.isAbove(earlyMessage.length, 0);

      const engineContext = yield* Layer.build(orchestrationEngineLayer);
      const engine = Context.get(engineContext, OrchestrationEngineService);
      const crypto = yield* Crypto.Crypto;
      const reportWarning = makeLaunchPreflightWarningReporter(engine, crypto);

      const harness = yield* makeTestProviderAdapterHarness();
      const registry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: harness.adapter,
      });
      const inbox = new Map<
        string,
        ReadonlyArray<{
          readonly code: LaunchPreflight.LaunchPreflightFindingCode;
          readonly message: string;
        }>
      >();
      const pathService = yield* Path.Path;
      inbox.set(
        LaunchPreflight.normalizePathKey(pathService, cwd),
        early.warnings.map((warning) => ({ code: warning.code, message: warning.message })),
      );

      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(ProviderSessionRuntime.layer),
      );
      const shared = Layer.mergeAll(
        directoryLayer,
        Layer.succeed(ProviderAdapterRegistry, registry),
        Layer.succeed(LaunchPreflightWarningInbox, inbox),
        ServerConfig.layerTest(cwd, cwd).pipe(Layer.provide(NodeServices.layer)),
        ServerSettingsService.layerTest({ ...DEFAULT_SERVER_SETTINGS, sharedSessionRoot: cwd }),
        AnalyticsService.layerTest,
        Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
      ).pipe(Layer.provide(SqlitePersistenceMemory));

      // The production reporter is the composition root's own closure; the
      // per-launch runner returns no findings so the only warning delivered is
      // the real pre-thread one. This is an observable, not a substituted sink.
      const providerLayer = makeProviderServiceLive({
        reportLaunchPreflightWarning: reportWarning,
        launchPreflightRunner: () => Effect.succeed(findingResult([])),
      }).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(shared));

      const projectId = ProjectId.make("a3-project");
      const threadId = ThreadId.make("a3-thread");
      const received = yield* Ref.make<ReadonlyArray<OrchestrationEvent>>([]);

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const events = yield* engine.subscribeDomainEvents;
        yield* events.pipe(
          Stream.tap((event) => Ref.update(received, (current) => [...current, event])),
          Stream.runDrain,
          Effect.forkScoped,
        );

        // The startup notice is already pending. The thread is created only
        // now, so the notice was found before it existed.
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("a3-project"),
          projectId,
          title: "A3",
          workspaceRoot: cwd,
          createdAt: "2026-09-28T00:00:00.000Z",
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("a3-thread"),
          threadId,
          projectId,
          title: "A3",
          modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-09-28T00:00:00.000Z",
        });

        const session = yield* provider.startSession(threadId, {
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd,
          runtimeMode: "full-access",
        });
        assert.equal(session.provider, "codex");
        // Warning-only launch started the configured provider exactly once.
        assert.equal(harness.getStartCount(), 1);

        // Give the forked subscription a chance to drain the appended event.
        yield* Effect.sleep("50 millis");
      }).pipe(Effect.provide(providerLayer));

      const collected = yield* Ref.get(received);
      const activities = collected.filter(
        (event): event is Extract<OrchestrationEvent, { type: "thread.activity-appended" }> =>
          event.type === "thread.activity-appended",
      );
      const warningActivity = activities.find(
        (event) => event.payload.activity.kind === "launch.preflight",
      );
      assert.isDefined(warningActivity, "no launch.preflight activity reached the subscription");
      assert.equal(warningActivity?.payload.activity.tone, "error");
      assert.strictEqual(warningActivity?.payload.activity.summary, earlyMessage);
      assert.equal(warningActivity?.payload.threadId, threadId);
      assert.deepStrictEqual(warningActivity?.payload.activity.payload, {
        code: "shared-root-git",
        cwd,
      });
      // A notice is not dropped before successful delivery: it was consumed.
      assert.strictEqual(inbox.size, 0);

      yield* Effect.promise(() =>
        import("node:fs/promises").then((fs) => fs.rm(cwd, { recursive: true, force: true })),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "A3: a notice is retained when the production report fails, and delivered by the next session",
  () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorkspaceDirectory;
      const code = "shared-root-git" as const;
      const message = "The shared session root is itself a Git repository.";
      const harness = yield* makeTestProviderAdapterHarness();
      const registry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: harness.adapter,
      });
      const pathService = yield* Path.Path;
      const inbox = new Map<string, ReadonlyArray<{ code: typeof code; message: string }>>();
      inbox.set(LaunchPreflight.normalizePathKey(pathService, cwd), [{ code, message }]);
      let attempt = 0;

      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(ProviderSessionRuntime.layer),
      );
      const shared = Layer.mergeAll(
        directoryLayer,
        Layer.succeed(ProviderAdapterRegistry, registry),
        Layer.succeed(LaunchPreflightWarningInbox, inbox),
        ServerConfig.layerTest(cwd, cwd).pipe(Layer.provide(NodeServices.layer)),
        ServerSettingsService.layerTest({ ...DEFAULT_SERVER_SETTINGS, sharedSessionRoot: cwd }),
        AnalyticsService.layerTest,
        Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
      ).pipe(Layer.provide(SqlitePersistenceMemory));
      const providerLayer = makeProviderServiceLive({
        // First delivery fails; the second succeeds.
        reportLaunchPreflightWarning: () =>
          Effect.sync(() => {
            attempt += 1;
            return attempt > 1;
          }),
        launchPreflightRunner: () => Effect.succeed(findingResult([])),
      }).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(shared));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = ThreadId.make("a3-retry-thread");
        yield* provider.startSession(threadId, {
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd,
          runtimeMode: "full-access",
        });
        // Failed delivery kept the notice pending for the next session.
        assert.strictEqual(inbox.size, 1);

        const secondThread = ThreadId.make("a3-retry-thread-2");
        yield* provider.startSession(secondThread, {
          threadId: secondThread,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd,
          runtimeMode: "full-access",
        });
        assert.strictEqual(attempt, 2);
        assert.strictEqual(inbox.size, 0);
      }).pipe(Effect.provide(providerLayer));

      yield* Effect.promise(() =>
        import("node:fs/promises").then((fs) => fs.rm(cwd, { recursive: true, force: true })),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

interface DeliveryProviderOptions {
  readonly cwd: string;
  readonly registry: ReturnType<typeof makeAdapterRegistryMock>;
  readonly inbox: Map<
    string,
    ReadonlyArray<{
      readonly code: LaunchPreflight.LaunchPreflightFindingCode;
      readonly message: string;
    }>
  >;
  readonly reportWarning: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly code: LaunchPreflight.LaunchPreflightFindingCode;
    readonly message: string;
  }) => Effect.Effect<boolean, never>;
}

const deliveryProviderLayer = (options: DeliveryProviderOptions) => {
  const directoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntime.layer),
  );
  const shared = Layer.mergeAll(
    directoryLayer,
    Layer.succeed(ProviderAdapterRegistry, options.registry),
    Layer.succeed(LaunchPreflightWarningInbox, options.inbox),
    ServerConfig.layerTest(options.cwd, options.cwd).pipe(Layer.provide(NodeServices.layer)),
    ServerSettingsService.layerTest({
      ...DEFAULT_SERVER_SETTINGS,
      sharedSessionRoot: options.cwd,
    }),
    AnalyticsService.layerTest,
    Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
  ).pipe(Layer.provide(SqlitePersistenceMemory));
  return makeProviderServiceLive({
    reportLaunchPreflightWarning: options.reportWarning,
    launchPreflightRunner: () => Effect.succeed(findingResult([])),
  }).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(shared));
};

it.live(
  "A3: a real configured dummy provider starts once and the production reporter delivers through the subscription",
  () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorkspaceDirectory;
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-a3-grok-")),
      );
      const argvLogPath = NodePath.join(dir, "argv.log");
      const mockAgentPath = NodePath.join(
        NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
        "../scripts/acp-mock-agent.ts",
      );
      const wrapperPath = writeFakeCli({
        directory: dir,
        name: "fake-grok-a3",
        source: execScriptSource({ scriptPath: mockAgentPath, argvLogPath }),
      });

      const engineContext = yield* Layer.build(orchestrationEngineLayer);
      const engine = Context.get(engineContext, OrchestrationEngineService);
      const crypto = yield* Crypto.Crypto;
      const reportWarning = makeLaunchPreflightWarningReporter(engine, crypto);

      const grokAdapter = yield* makeGrokAdapter(
        decodeGrokSettings({ binaryPath: wrapperPath }),
      ).pipe(
        Effect.provide(ServerConfig.layerTest(cwd, cwd)),
        Effect.provide(NodeServices.layer),
        Effect.orDie,
      );
      const registry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("grok")]: grokAdapter,
      });
      const message = "The shared session root is itself a Git repository.";
      const pathService = yield* Path.Path;
      const inbox = new Map<
        string,
        ReadonlyArray<{ code: LaunchPreflight.LaunchPreflightFindingCode; message: string }>
      >();
      inbox.set(LaunchPreflight.normalizePathKey(pathService, cwd), [
        { code: "shared-root-git", message },
      ]);

      const providerLayer = deliveryProviderLayer({
        cwd,
        registry,
        inbox,
        reportWarning,
      });

      const projectId = ProjectId.make("a3-grok-project");
      const threadId = ThreadId.make("a3-grok-thread");
      const received = yield* Ref.make<ReadonlyArray<OrchestrationEvent>>([]);

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const events = yield* engine.subscribeDomainEvents;
        yield* events.pipe(
          Stream.tap((event) => Ref.update(received, (current) => [...current, event])),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("a3-grok-project"),
          projectId,
          title: "A3",
          workspaceRoot: cwd,
          createdAt: "2026-09-28T00:00:00.000Z",
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("a3-grok-thread"),
          threadId,
          projectId,
          title: "A3",
          modelSelection: { instanceId: grokInstanceId, model: "grok-4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-09-28T00:00:00.000Z",
        });
        const session = yield* provider.startSession(threadId, {
          threadId,
          provider: ProviderDriverKind.make("grok"),
          providerInstanceId: grokInstanceId,
          cwd,
          runtimeMode: "full-access",
        });
        assert.equal(session.provider, "grok");
        yield* Effect.sleep("50 millis");
      }).pipe(Effect.provide(providerLayer));

      const collected = yield* Ref.get(received);
      const warningActivity = collected.find(
        (event) =>
          event.type === "thread.activity-appended" &&
          event.payload.activity.kind === "launch.preflight",
      );
      assert.isDefined(warningActivity);
      assert.strictEqual(
        warningActivity?.type === "thread.activity-appended"
          ? warningActivity.payload.activity.summary
          : undefined,
        message,
      );

      const invocations = yield* Effect.promise(() =>
        NodeFSP.readFile(argvLogPath, "utf8").then(
          (raw) => raw.split("\n").filter((line) => line.trim().length > 0).length,
          () => 0,
        ),
      );
      assert.equal(invocations, 1);
      assert.strictEqual(inbox.size, 0);

      yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
      yield* Effect.promise(() => NodeFSP.rm(cwd, { recursive: true, force: true }));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("A3: a missing configured executable fails before model work", () =>
  Effect.gen(function* () {
    const cwd = yield* makeWorkspaceDirectory;
    const pathService = yield* Path.Path;
    const missing = pathService.join(cwd, "not-a-real-grok");
    const engineContext = yield* Layer.build(orchestrationEngineLayer);
    const engine = Context.get(engineContext, OrchestrationEngineService);
    const crypto = yield* Crypto.Crypto;
    const reportWarning = makeLaunchPreflightWarningReporter(engine, crypto);
    const missingGrokAdapter = yield* makeGrokAdapter(
      decodeGrokSettings({ binaryPath: missing }),
    ).pipe(
      Effect.provide(ServerConfig.layerTest(cwd, cwd)),
      Effect.provide(NodeServices.layer),
      Effect.orDie,
    );
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("grok")]: missingGrokAdapter,
    });
    const inbox = new Map<
      string,
      ReadonlyArray<{ code: LaunchPreflight.LaunchPreflightFindingCode; message: string }>
    >();
    const providerLayer = deliveryProviderLayer({ cwd, registry, inbox, reportWarning });

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = ThreadId.make("a3-missing-exec-thread");
      const error = yield* provider
        .startSession(threadId, {
          threadId,
          provider: ProviderDriverKind.make("grok"),
          providerInstanceId: grokInstanceId,
          cwd,
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, ProviderAdapterProcessError);
      assert.include((error as ProviderAdapterProcessError).message, "grok");
    }).pipe(Effect.provide(providerLayer));

    yield* Effect.promise(() => NodeFSP.rm(cwd, { recursive: true, force: true }));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
// --- R3: production settings/instance construction selects the consumer ------------------------

interface CapturedLaunch {
  consumer?: LaunchPreflight.LaunchPreflightConsumer | undefined;
  gitEnvironment?: NodeJS.ProcessEnv | undefined;
}

const captureConsumerLayer = (options: {
  readonly cwd: string;
  readonly registry: ReturnType<typeof makeAdapterRegistryMock>;
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly captured: CapturedLaunch;
}) => {
  const directoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntime.layer),
  );
  const inbox = new Map<
    string,
    ReadonlyArray<{
      readonly code: LaunchPreflight.LaunchPreflightFindingCode;
      readonly message: string;
    }>
  >();
  const shared = Layer.mergeAll(
    directoryLayer,
    Layer.succeed(ProviderAdapterRegistry, options.registry),
    Layer.succeed(LaunchPreflightWarningInbox, inbox),
    ServerConfig.layerTest(options.cwd, options.cwd).pipe(Layer.provide(NodeServices.layer)),
    ServerSettingsService.layerTest({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: options.providerInstances,
    }),
    AnalyticsService.layerTest,
    Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
  ).pipe(Layer.provide(SqlitePersistenceMemory));
  return makeProviderServiceLive({
    reportLaunchPreflightWarning: () => Effect.succeed(true),
    launchPreflightRunner: (_root, runnerOptions) => {
      options.captured.consumer = runnerOptions?.consumer;
      options.captured.gitEnvironment = runnerOptions?.gitEnvironment;
      return Effect.succeed(findingResult([]));
    },
  }).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(shared));
};

const openCodeInstance = (overrides: {
  readonly config?: unknown;
  readonly environment?: ProviderInstanceConfig["environment"];
}): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make("opencode"),
  enabled: true,
  ...(overrides.config !== undefined ? { config: overrides.config } : {}),
  ...(overrides.environment !== undefined ? { environment: overrides.environment } : {}),
});

it.live(
  "R3: production settings select the launch consumer (local OpenCode, snapshot:false, external, fallback)",
  () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorkspaceDirectory;
      const sentinel = "envchk-e6-provider-sentinel";
      const codexHarness = yield* makeTestProviderAdapterHarness();
      const opencodeHarness = yield* makeTestProviderAdapterHarness({
        provider: ProviderDriverKind.make("opencode"),
      });
      const registry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: codexHarness.adapter,
        [ProviderDriverKind.make("opencode")]: opencodeHarness.adapter,
      });

      const runCase = (input: {
        readonly threadId: string;
        readonly provider: ProviderDriverKind;
        readonly providerInstanceId: ProviderInstanceId;
        readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
      }) =>
        Effect.gen(function* () {
          const captured: CapturedLaunch = {};
          const layer = captureConsumerLayer({
            cwd,
            registry,
            providerInstances: input.providerInstances,
            captured,
          });
          yield* Effect.gen(function* () {
            const provider = yield* ProviderService;
            const threadId = ThreadId.make(input.threadId);
            yield* provider.startSession(threadId, {
              threadId,
              provider: input.provider,
              providerInstanceId: input.providerInstanceId,
              cwd,
              runtimeMode: "full-access",
            });
          }).pipe(Effect.provide(layer));
          return captured;
        });

      // 1. Default local OpenCode: snapshots are on and the selected provider
      //    environment is threaded through unchanged.
      const local = yield* runCase({
        threadId: "r3-local",
        provider: ProviderDriverKind.make("opencode"),
        providerInstanceId: ProviderInstanceId.make("opencode"),
        providerInstances: {
          opencode: openCodeInstance({
            environment: [{ name: "ENVCHK_SENTINEL", value: sentinel, sensitive: false }],
          }),
        },
      });
      assert.deepStrictEqual(local.consumer, { driver: "opencode", snapshotsEnabled: true });
      assert.strictEqual(local.gitEnvironment?.ENVCHK_SENTINEL, sentinel);

      // 2. Effective `snapshot:false` in the selected instance's environment
      //    suppresses the provider-specific requirement.
      const disabled = yield* runCase({
        threadId: "r3-disabled",
        provider: ProviderDriverKind.make("opencode"),
        providerInstanceId: ProviderInstanceId.make("opencode"),
        providerInstances: {
          opencode: openCodeInstance({
            environment: [
              { name: "OPENCODE_CONFIG_CONTENT", value: '{"snapshot":false}', sensitive: false },
              { name: "ENVCHK_SENTINEL", value: sentinel, sensitive: false },
            ],
          }),
        },
      });
      assert.deepStrictEqual(disabled.consumer, { driver: "opencode", snapshotsEnabled: false });

      // 2b. W1-D: valid inline JSONC (comment + trailing comma) with
      //     snapshot:false is honored, not misread as enabled.
      const jsoncDisabled = yield* runCase({
        threadId: "r3-jsonc-disabled",
        provider: ProviderDriverKind.make("opencode"),
        providerInstanceId: ProviderInstanceId.make("opencode"),
        providerInstances: {
          opencode: openCodeInstance({
            environment: [
              {
                name: "OPENCODE_CONFIG_CONTENT",
                value: '{ /* staging off */ "snapshot": false, }',
                sensitive: false,
              },
            ],
          }),
        },
      });
      assert.deepStrictEqual(jsoncDisabled.consumer, {
        driver: "opencode",
        snapshotsEnabled: false,
      });

      // 2c. W1-D: unknown configuration is not asserted enabled.
      const unknownConfig = yield* runCase({
        threadId: "r3-unknown-config",
        provider: ProviderDriverKind.make("opencode"),
        providerInstanceId: ProviderInstanceId.make("opencode"),
        providerInstances: {
          opencode: openCodeInstance({
            environment: [
              { name: "OPENCODE_CONFIG_CONTENT", value: "not valid config", sensitive: false },
            ],
          }),
        },
      });
      assert.deepStrictEqual(unknownConfig.consumer, {
        driver: "opencode",
        snapshotsEnabled: undefined,
      });

      // 3. External OpenCode server: the local Git is not that process's Git.
      const external = yield* runCase({
        threadId: "r3-external",
        provider: ProviderDriverKind.make("opencode"),
        providerInstanceId: ProviderInstanceId.make("opencode"),
        providerInstances: {
          opencode: openCodeInstance({ config: { serverUrl: "http://127.0.0.1:4096" } }),
        },
      });
      assert.deepStrictEqual(external.consumer, { driver: "opencode", snapshotsEnabled: false });

      // 4. Non-OpenCode fallback: T3's own Git path only needs `--sparse` in a
      //    sparse checkout, which the repository probe decides.
      const fallback = yield* runCase({
        threadId: "r3-codex",
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerInstances: {
          codex: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
        },
      });
      assert.deepStrictEqual(fallback.consumer, { driver: "codex", snapshotsEnabled: true });

      yield* Effect.promise(() => NodeFSP.rm(cwd, { recursive: true, force: true }));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const writeSparseLessGit = (binDir: string, realGit: string): void => {
  writeFakeCli({
    directory: binDir,
    name: "git",
    platform: process.platform,
    source: [
      'import { spawnSync } from "node:child_process";',
      "const args = process.argv.slice(2);",
      'if (args[0] === "add" && args[1] === "-h") {',
      '  process.stdout.write("usage: git add [options] [--] <pathspec>...\\n    -n, --dry-run         dry run\\n    -v, --verbose         be verbose\\n");',
      "  process.exit(0);",
      "}",
      `const r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });`,
      "process.exit(r.status ?? 1);",
      "",
    ].join("\n"),
  });
};

const resolveRealGitPath = (): string =>
  NodeChildProcess.execFileSync(process.platform === "win32" ? "where.exe" : "which", ["git"], {
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "git";

it.live(
  "R3: a local OpenCode launch with default snapshots detects a controlled Git missing --sparse",
  () =>
    Effect.gen(function* () {
      const base = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-r3-sparse-")),
      );
      const repo = NodePath.join(base, "repo");
      const providerBin = NodePath.join(base, "provider-bin");
      yield* Effect.promise(() => NodeFSP.mkdir(repo, { recursive: true }));
      yield* Effect.promise(() => NodeFSP.mkdir(providerBin, { recursive: true }));
      const realGit = resolveRealGitPath();
      writeSparseLessGit(providerBin, realGit);
      const git = (args: ReadonlyArray<string>) =>
        Effect.promise(async () => {
          NodeChildProcess.execFileSync(realGit, args, { cwd: repo });
        });
      yield* git(["init", "-q"]);
      yield* git(["config", "user.name", "Test"]);
      yield* git(["config", "user.email", "test@test.com"]);
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(repo, "file.txt"), "hello\n"));
      yield* git(["add", "."]);
      yield* git(["commit", "-q", "-m", "initial"]);

      const harness = yield* makeTestProviderAdapterHarness({
        provider: ProviderDriverKind.make("opencode"),
      });
      const registry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("opencode")]: harness.adapter,
      });
      const reported = yield* Ref.make<
        ReadonlyArray<{ readonly code: string; readonly message: string }>
      >([]);
      const inbox = new Map<
        string,
        ReadonlyArray<{
          readonly code: LaunchPreflight.LaunchPreflightFindingCode;
          readonly message: string;
        }>
      >();
      const shared = Layer.mergeAll(
        ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntime.layer)),
        Layer.succeed(ProviderAdapterRegistry, registry),
        Layer.succeed(LaunchPreflightWarningInbox, inbox),
        ServerConfig.layerTest(repo, repo).pipe(Layer.provide(NodeServices.layer)),
        ServerSettingsService.layerTest({
          ...DEFAULT_SERVER_SETTINGS,
          // No OPENCODE_CONFIG_CONTENT: OpenCode's default snapshots are on. The
          // selected instance environment resolves the controlled sparse-less Git.
          providerInstances: {
            [ProviderInstanceId.make("opencode")]: {
              driver: ProviderDriverKind.make("opencode"),
              enabled: true,
              environment: [
                {
                  name: "PATH",
                  value: `${providerBin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
                  sensitive: false,
                },
              ],
            },
          },
        }),
        AnalyticsService.layerTest,
        Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
      ).pipe(Layer.provide(SqlitePersistenceMemory));
      // The real preflight runner runs, so the production-derived consumer and the
      // selected provider environment are what the capability probe inspects.
      const providerLayer = makeProviderServiceLive({
        reportLaunchPreflightWarning: ({ code, message }) =>
          Ref.update(reported, (current) => [...current, { code, message }]).pipe(Effect.as(true)),
      }).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(shared));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = ThreadId.make("r3-sparse");
        yield* provider.startSession(threadId, {
          threadId,
          provider: ProviderDriverKind.make("opencode"),
          providerInstanceId: ProviderInstanceId.make("opencode"),
          cwd: repo,
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      const warnings = yield* Ref.get(reported);
      const sparseWarning = warnings.find(
        (warning) => warning.code === "git-sparse-add-unsupported",
      );
      assert.isDefined(sparseWarning, "no git-sparse-add-unsupported warning was reported");
      assert.include(sparseWarning?.message ?? "", "OpenCode");
      assert.include(sparseWarning?.message ?? "", "--sparse");

      yield* Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true }));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// --- W1-C: configured shared root recognized through a physical alias (production settings) ---

it.live(
  "W1-C: a configured shared root is recognized through a physical alias (junction/symlink)",
  () =>
    Effect.gen(function* () {
      const base = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-w1c-alias-")),
      );
      const realRoot = NodePath.join(base, "real-root");
      const aliasRoot = NodePath.join(base, "alias-root");
      yield* Effect.promise(() => NodeFSP.mkdir(realRoot, { recursive: true }));
      // A Windows junction (or a POSIX directory symlink) is a real alias of the
      // same physical directory; the lexical spellings differ.
      yield* Effect.promise(() =>
        NodeFSP.symlink(realRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir"),
      );
      yield* Effect.promise(async () => {
        NodeChildProcess.execFileSync(resolveRealGitPath(), ["init", "-q"], { cwd: realRoot });
      });

      const harness = yield* makeTestProviderAdapterHarness();
      const registry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: harness.adapter,
      });
      const reported = yield* Ref.make<
        ReadonlyArray<{ readonly code: string; readonly message: string }>
      >([]);
      const inbox = new Map<
        string,
        ReadonlyArray<{
          readonly code: LaunchPreflight.LaunchPreflightFindingCode;
          readonly message: string;
        }>
      >();
      const shared = Layer.mergeAll(
        ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntime.layer)),
        Layer.succeed(ProviderAdapterRegistry, registry),
        Layer.succeed(LaunchPreflightWarningInbox, inbox),
        ServerConfig.layerTest(aliasRoot, aliasRoot).pipe(Layer.provide(NodeServices.layer)),
        ServerSettingsService.layerTest({
          ...DEFAULT_SERVER_SETTINGS,
          // The canonical root is configured; the session cwd is the alias.
          sharedSessionRoot: realRoot,
        }),
        AnalyticsService.layerTest,
        Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
      ).pipe(Layer.provide(SqlitePersistenceMemory));
      const providerLayer = makeProviderServiceLive({
        reportLaunchPreflightWarning: ({ code, message }) =>
          Ref.update(reported, (current) => [...current, { code, message }]).pipe(Effect.as(true)),
      }).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(shared));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = ThreadId.make("w1c-alias");
        yield* provider.startSession(threadId, {
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: aliasRoot,
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      const warnings = yield* Ref.get(reported);
      assert.isTrue(
        warnings.some((warning) => warning.code === "shared-root-git"),
        `expected shared-root-git through the physical alias; got ${JSON.stringify(warnings)}`,
      );

      yield* Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true }));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// --- W1-B: non-OpenCode launch in a verified sparse checkout, incomplete probe warns ---------

it.live(
  "W1-B: a non-OpenCode launch in a verified sparse checkout warns when the capability probe fails",
  () =>
    Effect.gen(function* () {
      const base = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-w1b-sparse-")),
      );
      const repo = NodePath.join(base, "repo");
      const providerBin = NodePath.join(base, "provider-bin");
      yield* Effect.promise(() => NodeFSP.mkdir(repo, { recursive: true }));
      yield* Effect.promise(() => NodeFSP.mkdir(providerBin, { recursive: true }));
      const realGit = resolveRealGitPath();
      writeSparseLessGit(providerBin, realGit);
      const git = (args: ReadonlyArray<string>) =>
        Effect.promise(async () => {
          NodeChildProcess.execFileSync(realGit, args, { cwd: repo });
        });
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(repo, "src"), { recursive: true }));
      yield* git(["init", "-q"]);
      yield* git(["config", "user.name", "Test"]);
      yield* git(["config", "user.email", "test@test.com"]);
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(repo, "src", "file.txt"), "hi\n"));
      yield* git(["add", "."]);
      yield* git(["commit", "-q", "-m", "initial"]);
      // A real sparse checkout makes `git add --sparse` relevant for T3's own
      // checkpoint path, independent of the selected (non-OpenCode) consumer.
      yield* git(["sparse-checkout", "set", "src"]);

      const harness = yield* makeTestProviderAdapterHarness();
      const registry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: harness.adapter,
      });
      const reported = yield* Ref.make<
        ReadonlyArray<{ readonly code: string; readonly message: string }>
      >([]);
      const inbox = new Map<
        string,
        ReadonlyArray<{
          readonly code: LaunchPreflight.LaunchPreflightFindingCode;
          readonly message: string;
        }>
      >();
      const shared = Layer.mergeAll(
        ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntime.layer)),
        Layer.succeed(ProviderAdapterRegistry, registry),
        Layer.succeed(LaunchPreflightWarningInbox, inbox),
        ServerConfig.layerTest(repo, repo).pipe(Layer.provide(NodeServices.layer)),
        ServerSettingsService.layerTest({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              environment: [
                {
                  name: "PATH",
                  value: `${providerBin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
                  sensitive: false,
                },
              ],
            },
          },
        }),
        AnalyticsService.layerTest,
        Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
      ).pipe(Layer.provide(SqlitePersistenceMemory));
      const providerLayer = makeProviderServiceLive({
        reportLaunchPreflightWarning: ({ code, message }) =>
          Ref.update(reported, (current) => [...current, { code, message }]).pipe(Effect.as(true)),
      }).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(shared));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = ThreadId.make("w1b-sparse");
        yield* provider.startSession(threadId, {
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: repo,
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      const warnings = yield* Ref.get(reported);
      const sparseWarning = warnings.find(
        (warning) => warning.code === "git-sparse-add-unsupported",
      );
      assert.isDefined(
        sparseWarning,
        `expected a sparse-checkout capability warning; got ${JSON.stringify(warnings)}`,
      );
      // The non-OpenCode path uses the sparse-checkout message, not the
      // consumer-specific one.
      assert.include(sparseWarning?.message ?? "", "sparse");
      assert.notInclude(sparseWarning?.message ?? "", "OpenCode");

      yield* Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true }));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

