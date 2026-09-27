import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { makeAdapterRegistryMock } from "../src/provider/testUtils/providerAdapterRegistryMock.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../src/provider/Layers/ProviderEventLoggers.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import { ProviderLaunchPreflightBlockedError } from "../src/provider/Errors.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../src/provider/Services/ProviderService.ts";
import * as ServerConfig from "../src/config.ts";
import * as LaunchPreflight from "../src/environment/LaunchPreflight.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
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
  readonly layer: Layer.Layer<ProviderService, unknown, never>;
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
  readonly launchPreflightRunner?: (
    root: string,
  ) => Effect.Effect<LaunchPreflight.LaunchPreflightResult>;
  readonly reportLaunchPreflightWarning?: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly code: LaunchPreflight.LaunchPreflightFindingCode;
    readonly message: string;
  }) => Effect.Effect<void, never>;
}) =>
  Effect.gen(function* () {
    const cwd = yield* makeWorkspaceDirectory;
    const harness = yield* makeTestProviderAdapterHarness();

    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: harness.adapter,
    });

    const directoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntime.layer),
    );

    const shared = Layer.mergeAll(
      directoryLayer,
      Layer.succeed(ProviderAdapterRegistry, registry),
      ServerConfig.layerTest(cwd, cwd).pipe(Layer.provide(NodeServices.layer)),
      ServerSettingsService.layerTest(DEFAULT_SERVER_SETTINGS),
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
    }).pipe(Layer.provide(NodeServices.layer), Layer.provide(shared));

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
        Ref.update(reported, (current) => [...current, message]),
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
      assert.deepStrictEqual(yield* Ref.get(reported), [warningFinding.message]);
    }).pipe(Effect.provide(fixture.layer));
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
