// @effect-diagnostics nodeBuiltinImport:off - a real temporary workspace exercises the launch path.
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
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
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../src/provider/Layers/ProviderEventLoggers.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../src/provider/Services/ProviderService.ts";
import { makeAdapterRegistryMock } from "../src/provider/testUtils/providerAdapterRegistryMock.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { AnalyticsService } from "../src/telemetry/AnalyticsService.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";
import { makeTestProviderAdapterHarness } from "./TestProviderAdapter.integration.ts";

const codexInstanceId = ProviderInstanceId.make("codex");

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