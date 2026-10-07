// @effect-diagnostics nodeBuiltinImport:off - the real dummy-executable fixture writes a launcher with node fs/path.
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { GrokSettings, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { makeAdapterRegistryMock } from "../src/provider/testUtils/providerAdapterRegistryMock.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../src/provider/Services/ProviderSessionDirectory.ts";
import { makeGrokAdapter } from "../src/provider/Layers/GrokAdapter.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../src/provider/Layers/ProviderEventLoggers.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import {
  ProviderAdapterProcessError,
  ProviderLaunchPreflightBlockedError,
} from "../src/provider/Errors.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../src/provider/Services/ProviderService.ts";
import * as ServerConfig from "../src/config.ts";
import * as LaunchPreflight from "../src/environment/LaunchPreflight.ts";
import { LaunchPreflightWarningInbox } from "../src/environment/LaunchPreflightWarningInbox.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { execScriptSource, writeFakeCli } from "../src/testUtils/fakeCli.ts";
import { AnalyticsService } from "../src/telemetry/AnalyticsService.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../src/persistence/ProviderSessionRuntime.ts";

import {
  makeTestProviderAdapterHarness,
  type TestProviderAdapterHarness,
  type TestTurnResponse,
} from "./TestProviderAdapter.integration.ts";
import {
  codexTurnApprovalFixture,
  codexTurnToolFixture,
  codexTurnTextFixture,
} from "./fixtures/providerRuntime.ts";

const codexInstanceId = ProviderInstanceId.make("codex");
const grokInstanceId = ProviderInstanceId.make("grok");
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const makeWorkspaceDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectory();
  yield* fs.writeFileString(pathService.join(cwd, "README.md"), "v1\n");
  return cwd;
}).pipe(Effect.provide(NodeServices.layer));

interface IntegrationFixture {
  readonly cwd: string;
  readonly harness: TestProviderAdapterHarness;
  readonly layer: Layer.Layer<ProviderService | ProviderSessionDirectory, unknown, never>;
}

interface RecordedAnalyticsEvent {
  readonly event: string;
  readonly properties: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Analytics layer that keeps captured events in memory so tests can assert on
 * telemetry payloads. `AnalyticsService.layerTest` discards them.
 */
const makeRecordingAnalytics = Effect.gen(function* () {
  const recorded = yield* Ref.make<ReadonlyArray<RecordedAnalyticsEvent>>([]);
  const layer = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: (event, properties) =>
        Ref.update(recorded, (current) => [...current, { event, properties }]),
      flush: Effect.void,
    }),
  );
  return { layer, get: Ref.get(recorded) } as const;
});

const makeIntegrationFixture = (options?: {
  readonly analytics?: Layer.Layer<AnalyticsService>;
  readonly grokBinaryPath?: string;
  readonly serverConfigCwd?: string;
  readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
  /** Configure the workspace directory itself as the shared session root. */
  readonly sharedSessionRootIsWorkspace?: boolean;
  /** Pre-seed the pre-thread startup warning inbox for the workspace cwd. */
  readonly pendingWarnings?: ReadonlyArray<{
    readonly code: LaunchPreflight.LaunchPreflightFindingCode;
    readonly message: string;
  }>;
  readonly launchPreflightRunner?: (
    root: string,
    options?: {
      readonly isSharedRoot?: boolean;
      readonly configuredRoot?: string;
      readonly consumer?: LaunchPreflight.LaunchPreflightConsumer;
      readonly gitEnvironment?: NodeJS.ProcessEnv;
      readonly providerGitEnvironment?: NodeJS.ProcessEnv;
    },
  ) => Effect.Effect<LaunchPreflight.LaunchPreflightResult>;
  readonly reportLaunchPreflightWarning?: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly code: LaunchPreflight.LaunchPreflightFindingCode;
    readonly message: string;
  }) => Effect.Effect<boolean, never>;
}) =>
  Effect.gen(function* () {
    const cwd = yield* makeWorkspaceDirectory;
    const harness = yield* makeTestProviderAdapterHarness();
    const pathService = yield* Path.Path;
    const inbox = new Map<
      string,
      ReadonlyArray<{
        readonly code: LaunchPreflight.LaunchPreflightFindingCode;
        readonly message: string;
      }>
    >();
    if (options?.pendingWarnings !== undefined) {
      inbox.set(LaunchPreflight.normalizePathKey(pathService, cwd), options.pendingWarnings);
    }

    // A real adapter whose configured executable is the caller's path, so a
    // launch exercises the actual platform spawn/error path (not a mock).
    const realAdapters =
      options?.grokBinaryPath === undefined
        ? {}
        : {
            [ProviderDriverKind.make("grok")]: yield* makeGrokAdapter(
              decodeGrokSettings({ binaryPath: options.grokBinaryPath }),
            ).pipe(
              Effect.provide(
                ServerConfig.layerTest(cwd, cwd).pipe(Layer.provideMerge(NodeServices.layer)),
              ),
              Effect.orDie,
            ),
          };

    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: harness.adapter,
      ...realAdapters,
    });

    const directoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntime.layer),
    );

    const shared = Layer.mergeAll(
      directoryLayer,
      Layer.succeed(ProviderAdapterRegistry, registry),
      Layer.succeed(LaunchPreflightWarningInbox, inbox),
      ServerConfig.layerTest(options?.serverConfigCwd ?? cwd, cwd).pipe(
        Layer.provide(NodeServices.layer),
      ),
      ServerSettingsService.layerTest({
        ...(options?.settings ?? DEFAULT_SERVER_SETTINGS),
        ...(options?.sharedSessionRootIsWorkspace ? { sharedSessionRoot: cwd } : {}),
      }),
      options?.analytics ?? AnalyticsService.layerTest,
      Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
    ).pipe(Layer.provide(SqlitePersistenceMemory));

    const layer = makeProviderServiceLive({
      ...(options?.launchPreflightRunner !== undefined
        ? { launchPreflightRunner: options.launchPreflightRunner }
        : {}),
      ...(options?.reportLaunchPreflightWarning !== undefined
        ? { reportLaunchPreflightWarning: options.reportLaunchPreflightWarning }
        : {}),
    }).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(shared));

    return {
      cwd,
      harness,
      layer,
    } satisfies IntegrationFixture;
  });

const collectEventsDuring = <A, E, R>(
  stream: Stream.Stream<ProviderRuntimeEvent>,
  count: number,
  action: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* Stream.runForEach(stream, (event) => Queue.offer(queue, event).pipe(Effect.asVoid)).pipe(
      Effect.forkScoped,
    );

    yield* Effect.sleep("50 millis");
    yield* action;

    return yield* Effect.forEach(
      Array.from({ length: count }, () => undefined),
      () => Queue.take(queue),
      { discard: false },
    );
  });

const runTurn = (input: {
  readonly provider: ProviderServiceShape;
  readonly harness: TestProviderAdapterHarness;
  readonly threadId: ThreadId;
  readonly userText: string;
  readonly response: TestTurnResponse;
}) =>
  Effect.gen(function* () {
    yield* input.harness.queueTurnResponse(input.threadId, input.response);
    return yield* collectEventsDuring(
      input.provider.streamEvents,
      input.response.events.length,
      input.provider.sendTurn({
        threadId: input.threadId,
        input: input.userText,
        attachments: [],
      }),
    );
  });

it.live("replays typed runtime fixture events", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture();

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(ThreadId.make("thread-integration-typed"), {
        threadId: ThreadId.make("thread-integration-typed"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
      assert.equal((session.threadId ?? "").length > 0, true);

      const observedEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "hello",
        response: { events: codexTurnTextFixture },
      });

      assert.deepEqual(
        observedEvents.map((event) => event.type),
        codexTurnTextFixture.map((event) => event.type),
      );
      assert.deepEqual(
        observedEvents.map((event) => event.providerInstanceId),
        codexTurnTextFixture.map(() => codexInstanceId),
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("replays file-changing fixture turn events", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture();
    const { join } = yield* Path.Path;
    const { writeFileString } = yield* FileSystem.FileSystem;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(ThreadId.make("thread-integration-tools"), {
        threadId: ThreadId.make("thread-integration-tools"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
      assert.equal((session.threadId ?? "").length > 0, true);

      const observedEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "make a small change",
        response: {
          events: codexTurnToolFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });

      assert.deepEqual(
        observedEvents.map((event) => event.type),
        codexTurnToolFixture.map((event) => event.type),
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("runs multi-turn tool/approval flow", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture();
    const { join } = yield* Path.Path;
    const { writeFileString } = yield* FileSystem.FileSystem;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(ThreadId.make("thread-integration-multi"), {
        threadId: ThreadId.make("thread-integration-multi"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
      assert.equal((session.threadId ?? "").length > 0, true);

      const firstTurnEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 1",
        response: {
          events: codexTurnToolFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });
      assert.deepEqual(
        firstTurnEvents.map((event) => event.type),
        codexTurnToolFixture.map((event) => event.type),
      );

      const secondTurnEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 2 approval",
        response: {
          events: codexTurnApprovalFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v3\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });
      assert.deepEqual(
        secondTurnEvents.map((event) => event.type),
        codexTurnApprovalFixture.map((event) => event.type),
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rolls back provider conversation state only", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture();
    const { join } = yield* Path.Path;
    const { writeFileString, readFileString } = yield* FileSystem.FileSystem;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(ThreadId.make("thread-integration-rollback"), {
        threadId: ThreadId.make("thread-integration-rollback"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
      assert.equal((session.threadId ?? "").length > 0, true);

      yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 1",
        response: {
          events: codexTurnToolFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });

      yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 2 approval",
        response: {
          events: codexTurnApprovalFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v3\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 1,
      });

      const rollbackCalls = fixture.harness.getRollbackCalls(session.threadId);
      assert.deepEqual(rollbackCalls, [1]);

      const readme = yield* readFileString(join(fixture.cwd, "README.md"));
      assert.equal(readme, "v3\n");
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reports runtime mode per turn and on mode transitions", () =>
  Effect.gen(function* () {
    const analytics = yield* makeRecordingAnalytics;
    const fixture = yield* makeIntegrationFixture({ analytics: analytics.layer });
    const threadId = ThreadId.make("thread-integration-runtime-mode");

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const startSession = (runtimeMode: "approval-required" | "full-access") =>
        provider.startSession(threadId, {
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: fixture.cwd,
          runtimeMode,
        });

      yield* startSession("approval-required");
      yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId,
        userText: "supervised turn",
        response: { events: codexTurnTextFixture },
      });

      // Toggling the mode restarts the session, which is the only place the
      // transition is observable.
      yield* startSession("full-access");
      yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId,
        userText: "full access turn",
        response: { events: codexTurnTextFixture },
      });

      const recorded = yield* analytics.get;

      assert.deepEqual(
        recorded
          .filter((entry) => entry.event === "provider.turn.sent")
          .map((entry) => entry.properties?.runtimeMode),
        ["approval-required", "full-access"],
      );

      assert.deepEqual(
        recorded
          .filter((entry) => entry.event === "provider.runtime_mode.changed")
          .map((entry) => [entry.properties?.from, entry.properties?.to]),
        [["approval-required", "full-access"]],
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

const blockedFinding: LaunchPreflight.LaunchPreflightFinding = {
  code: "git-startup-failed",
  severity: "blocker",
  message: "Git could not start; the session cannot checkpoint. Fix Git and retry.",
};

const warningFinding: LaunchPreflight.LaunchPreflightFinding = {
  code: "shared-root-git",
  severity: "warning",
  message: "The shared session root is itself a Git repository.",
};

const findingResult = (
  findings: ReadonlyArray<LaunchPreflight.LaunchPreflightFinding>,
): LaunchPreflight.LaunchPreflightResult => ({
  findings,
  warnings: findings.filter((finding) => finding.severity === "warning"),
  blockers: findings.filter((finding) => finding.severity === "blocker"),
});

it.live("a launch-preflight blocker prevents the new provider session from starting", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture({
      launchPreflightRunner: () => Effect.succeed(findingResult([blockedFinding])),
    });

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const error = yield* provider
        .startSession(ThreadId.make("thread-preflight-blocked"), {
          threadId: ThreadId.make("thread-preflight-blocked"),
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, ProviderLaunchPreflightBlockedError);
      const sessions = yield* fixture.harness.adapter.listSessions();
      assert.equal(sessions.length, 0);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a launch-preflight warning is reported and the session still starts once", () =>
  Effect.gen(function* () {
    const reported = yield* Ref.make<ReadonlyArray<string>>([]);
    const fixture = yield* makeIntegrationFixture({
      launchPreflightRunner: () => Effect.succeed(findingResult([warningFinding])),
      reportLaunchPreflightWarning: ({ message }) =>
        Ref.update(reported, (current) => [...current, message]).pipe(Effect.as(true)),
    });

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(ThreadId.make("thread-preflight-warned"), {
        threadId: ThreadId.make("thread-preflight-warned"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });

      assert.equal((session.threadId ?? "").length > 0, true);
      assert.equal(fixture.harness.getStartCount(), 1);
      assert.deepStrictEqual(yield* Ref.get(reported), [warningFinding.message]);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("an unexpected preflight failure warns and starts the provider once", () =>
  Effect.gen(function* () {
    const reported = yield* Ref.make<ReadonlyArray<string>>([]);
    const fixture = yield* makeIntegrationFixture({
      launchPreflightRunner: () => Effect.die("unexpected probe failure"),
      reportLaunchPreflightWarning: ({ code }) =>
        Ref.update(reported, (current) => [...current, code]).pipe(Effect.as(true)),
    });
    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = ThreadId.make("thread-preflight-defect");
      yield* provider.startSession(threadId, {
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
      assert.equal(fixture.harness.getStartCount(), 1);
      assert.deepStrictEqual(yield* Ref.get(reported), ["git-probe-failed"]);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("the same repository at the server cwd is ordinary by default", () =>
  Effect.gen(function* () {
    const seen: Array<{ readonly isSharedRoot?: boolean; readonly configuredRoot?: string }> = [];
    const fixture = yield* makeIntegrationFixture({
      launchPreflightRunner: (_root, options) => {
        seen.push({
          ...(options?.isSharedRoot !== undefined ? { isSharedRoot: options.isSharedRoot } : {}),
          ...(options?.configuredRoot !== undefined
            ? { configuredRoot: options.configuredRoot }
            : {}),
        });
        return Effect.succeed(findingResult([]));
      },
    });

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      yield* provider.startSession(ThreadId.make("thread-shared-default"), {
        threadId: ThreadId.make("thread-shared-default"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
    }).pipe(Effect.provide(fixture.layer));

    // No shared root is configured, so neither an explicit shared-root override
    // nor a configured root is handed to the bounded preflight.
    assert.deepStrictEqual(seen, [{}]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "a configured shared session root is carried into the preflight independently of the cwd",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const otherBackendCwd = yield* fs.makeTempDirectory();
      const seen: Array<{ readonly isSharedRoot?: boolean; readonly configuredRoot?: string }> = [];
      const fixture = yield* makeIntegrationFixture({
        serverConfigCwd: otherBackendCwd,
        sharedSessionRootIsWorkspace: true,
        launchPreflightRunner: (_root, options) => {
          seen.push({
            ...(options?.isSharedRoot !== undefined ? { isSharedRoot: options.isSharedRoot } : {}),
            ...(options?.configuredRoot !== undefined
              ? { configuredRoot: options.configuredRoot }
              : {}),
          });
          return Effect.succeed(findingResult([]));
        },
      });
      const nested = path.join(fixture.cwd, "nested");
      yield* fs.makeDirectory(nested, { recursive: true });

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        // The exact configured root is carried into the bounded preflight even
        // though the backend cwd is a different directory.
        yield* provider.startSession(ThreadId.make("thread-shared-root"), {
          threadId: ThreadId.make("thread-shared-root"),
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        });
        // A nested repository selected as the session cwd still receives the
        // configured root; the preflight owns the canonical comparison and keeps
        // the nested repository ordinary (covered by the real-preflight suites).
        yield* provider.startSession(ThreadId.make("thread-shared-nested"), {
          threadId: ThreadId.make("thread-shared-nested"),
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: nested,
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(fixture.layer));

      assert.deepStrictEqual(seen, [
        { configuredRoot: fixture.cwd },
        { configuredRoot: fixture.cwd },
      ]);
      // Clean up the extra backend cwd owned by this fixture.
      yield* fs.remove(otherBackendCwd, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("the launch preflight inspects the selected provider environment", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const providerBin = yield* fs.makeTempDirectory();
    const sentinel = "envchk-integration-sentinel";
    const captured: Array<{
      readonly consumer?: LaunchPreflight.LaunchPreflightConsumer | undefined;
      readonly providerGitEnvironment?: NodeJS.ProcessEnv | undefined;
    }> = [];
    const fixture = yield* makeIntegrationFixture({
      settings: {
        providerInstances: {
          [ProviderInstanceId.make("codex")]: {
            driver: "codex",
            environment: [
              { name: "PATH", value: providerBin },
              { name: "ENVCHK_SENTINEL", value: sentinel },
            ],
          },
        },
      },
      launchPreflightRunner: (_root, options) => {
        captured.push({
          consumer: options?.consumer,
          providerGitEnvironment: options?.providerGitEnvironment,
        });
        return Effect.succeed(findingResult([]));
      },
    });

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      yield* provider.startSession(ThreadId.make("thread-provider-env"), {
        threadId: ThreadId.make("thread-provider-env"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
    }).pipe(Effect.provide(fixture.layer));

    assert.strictEqual(captured.length, 1);
    // The selected consumer is passed to the preflight.
    assert.strictEqual(captured[0]?.consumer?.driver, "codex");
    // The launch environment is the selected provider environment layered over
    // the host: the sentinel and PATH come from the instance (replacement),
    // while unrelated host variables are inherited.
    const environment = captured[0]?.providerGitEnvironment;
    assert.isDefined(environment);
    assert.strictEqual(environment?.ENVCHK_SENTINEL, sentinel);
    assert.strictEqual(environment?.PATH, providerBin);
    assert.strictEqual(environment?.HOME, process.env.HOME);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("pre-thread startup warnings reach the first affected session", () =>
  Effect.gen(function* () {
    const reported = yield* Ref.make<ReadonlyArray<string>>([]);
    const fixture = yield* makeIntegrationFixture({
      launchPreflightRunner: () => Effect.succeed(findingResult([])),
      reportLaunchPreflightWarning: ({ message }) =>
        Ref.update(reported, (current) => [...current, message]).pipe(Effect.as(true)),
      pendingWarnings: [{ code: "shared-root-git", message: "startup umbrella warning" }],
    });

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      yield* provider.startSession(ThreadId.make("thread-startup-warning"), {
        threadId: ThreadId.make("thread-startup-warning"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
    }).pipe(Effect.provide(fixture.layer));

    assert.deepStrictEqual(yield* Ref.get(reported), ["startup umbrella warning"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("the recovery path also invokes the launch preflight", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const fixture = yield* makeIntegrationFixture({
      launchPreflightRunner: () =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.map((count) => findingResult(count === 1 ? [] : [blockedFinding])),
        ),
    });

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = ThreadId.make("thread-preflight-recovery");
      yield* provider.startSession(threadId, {
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });

      // Drop the adapter session but keep the persisted binding so the next
      // sendTurn must recover it.
      yield* fixture.harness.adapter.stopSession(threadId);

      const error = yield* provider
        .sendTurn({ threadId, input: "recover me", attachments: [] })
        .pipe(Effect.flip);

      assert.instanceOf(error, ProviderLaunchPreflightBlockedError);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

// --- R2 / R4: the real configured executable through the real launch composition ---------------

it.live(
  "a missing configured provider executable is reported before model work (new session)",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const missing = path.join(yield* fs.makeTempDirectory(), "grok");
      const fixture = yield* makeIntegrationFixture({ grokBinaryPath: missing });

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const directory = yield* ProviderSessionDirectory;
        const threadId = ThreadId.make("thread-real-exec-missing-new");

        const error = yield* provider
          .startSession(threadId, {
            threadId,
            provider: ProviderDriverKind.make("grok"),
            providerInstanceId: grokInstanceId,
            cwd: fixture.cwd,
            runtimeMode: "full-access",
          })
          .pipe(Effect.flip);

        assert.instanceOf(error, ProviderAdapterProcessError);
        assert.include((error as ProviderAdapterProcessError).message, "grok");
        assert.isAbove((error as ProviderAdapterProcessError).message.length, 0);
        // No session was accepted and no turn/model work could have run.
        const sessions = yield* fixture.harness.adapter.listSessions();
        assert.equal(sessions.length, 0);
        assert.isTrue(Option.isNone(yield* directory.getBinding(threadId)));
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("recovery/resume reports the same missing configured executable before model work", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const missing = path.join(yield* fs.makeTempDirectory(), "grok");
    const fixture = yield* makeIntegrationFixture({ grokBinaryPath: missing });

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = ThreadId.make("thread-real-exec-missing-recover");

      // A persisted binding with resume state is all recovery needs; the
      // configured executable is resolved and spawned by the same adapter path
      // as a new session.
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        providerInstanceId: grokInstanceId,
        resumeCursor: { sessionId: "resume-e3" },
        runtimePayload: { cwd: fixture.cwd },
        runtimeMode: "full-access",
      });

      const error = yield* provider
        .sendTurn({ threadId, input: "recover me", attachments: [] })
        .pipe(Effect.flip);

      assert.instanceOf(error, ProviderAdapterProcessError);
      assert.include((error as ProviderAdapterProcessError).message, "grok");
      assert.isAbove((error as ProviderAdapterProcessError).message.length, 0);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a real configured dummy provider executable launches exactly once and warns visibly", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-e3-grok-wrapper-")),
    );
    const argvLogPath = NodePath.join(dir, "argv.log");
    const mockAgentPath = NodePath.join(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "../scripts/acp-mock-agent.ts",
    );
    const wrapperPath = writeFakeCli({
      directory: dir,
      name: "fake-grok-e3",
      source: execScriptSource({ scriptPath: mockAgentPath, argvLogPath }),
    });

    const reported = yield* Ref.make<ReadonlyArray<string>>([]);
    const fixture = yield* makeIntegrationFixture({
      grokBinaryPath: wrapperPath,
      launchPreflightRunner: () => Effect.succeed(findingResult([warningFinding])),
      reportLaunchPreflightWarning: ({ message }) =>
        Ref.update(reported, (current) => [...current, message]).pipe(Effect.as(true)),
    });

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = ThreadId.make("thread-real-exec-healthy");
      const session = yield* provider.startSession(threadId, {
        threadId,
        provider: ProviderDriverKind.make("grok"),
        providerInstanceId: grokInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "grok");
      assert.isTrue((session.threadId ?? "").length > 0);
      // The real configured executable was spawned exactly once, and the client
      // still received the actionable warning.
      const invocations = yield* Effect.promise(() =>
        NodeFSP.readFile(argvLogPath, "utf8").then(
          (raw) => raw.split("\n").filter((line) => line.trim().length > 0).length,
          () => 0,
        ),
      );
      assert.equal(invocations, 1);
      assert.deepStrictEqual(yield* Ref.get(reported), [warningFinding.message]);
    }).pipe(Effect.provide(fixture.layer));

    yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
  }).pipe(Effect.provide(NodeServices.layer)),
);
