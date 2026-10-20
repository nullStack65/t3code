import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as CodexInstallation from "../CodexInstallation.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { makeProviderInstanceRegistry } from "../ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../ProviderInstanceRegistryHydration.ts";
import {
  CodexTypedSkillAdmissionRefused,
  CodexTypedSkillsDriver,
  CodexTypedSkillsSettings,
} from "./CodexTypedSkillsDriver.ts";
const layerDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-codex-driver-maintenance-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.mock(CodexAdapterV2.CodexAppServerClientFactory)({
      open: () => Effect.die("Maintenance resolution must not open a Codex session"),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(CodexInstallation.CodexInstallation)({
      managedDirectory: "unused-managed-installation",
    }),
  ),
  Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
    }),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Codex must not make an HTTP request")),
    ),
  ),
);
const unusedServices = ProviderHostLive.layer.pipe(Layer.provideMerge(layerDeps));

const instanceId = ProviderInstanceId.make("governed-codex");
const codexId = ProviderInstanceId.make("codex");
const candidate = {
  directory: "/synthetic/never-read/candidate",
  sourceRepository: "nullStack65/closura-agent-config",
  sourceCommit: "a".repeat(40),
  admissionSha256: "b".repeat(64),
};
const decodeSettings = Schema.decodeUnknownSync(CodexTypedSkillsSettings);

it("does not bootstrap a typed default or replace an explicit typed route with legacy Codex", () => {
  const defaults = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
  expect(Object.values(defaults).some((entry) => entry.driver === "codex-typed-skills")).toBe(
    false,
  );
  expect(defaults[codexId]?.driver).toBe("codex");

  const explicit = {
    driver: CodexTypedSkillsDriver.driverKind,
    config: { candidate },
  };
  const hydrated = deriveProviderInstanceConfigMap({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: { [codexId]: explicit },
  });
  expect(hydrated[codexId]).toEqual(explicit);
});

it.effect(
  "refuses candidate references without acquiring filesystem, process or auth services",
  () =>
    Effect.gen(function* () {
      for (const config of [
        {},
        { candidate },
        // Extra offline or model-generated claims never turn a request into proof.
        { candidate, admissionAuthorized: true, trustedObserver: true, nativeGateSupported: true },
      ]) {
        const error = yield* Effect.flip(
          CodexTypedSkillsDriver.create({
            instanceId,
            displayName: undefined,
            enabled: true,
            environment: [
              { name: "HOME", value: "/synthetic/uncontrolled-home", sensitive: false },
              {
                name: "CODEX_HOME",
                value: "/synthetic/shared-skills-and-plugins",
                sensitive: false,
              },
            ],
            config: decodeSettings(config),
          }),
        );
        expect(error.cause).toBeInstanceOf(CodexTypedSkillAdmissionRefused);
        expect(error.cause).toMatchObject({
          admissionAuthorized: false,
          reason: "native-boundary-unqualified",
          instanceId,
        });
        expect(error.detail).not.toContain(candidate.directory);
      }
    }).pipe(Effect.scoped, Effect.provide(unusedServices)),
);

it.effect(
  "the registered native route offers no skills, models, adapter or text-generation fallback",
  () =>
    Effect.gen(function* () {
      expect(BUILT_IN_DRIVERS).toContain(CodexTypedSkillsDriver);
      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers: [CodexTypedSkillsDriver],
        configMap: {
          [instanceId]: { driver: CodexTypedSkillsDriver.driverKind, config: { candidate } },
        },
      });
      expect(yield* registry.getInstance(instanceId)).toBeUndefined();
      expect(yield* registry.listInstances).toEqual([]);
      const [snapshot] = yield* registry.listUnavailable;
      expect(snapshot).toMatchObject({
        instanceId,
        driver: "codex-typed-skills",
        availability: "unavailable",
        enabled: false,
        models: [],
        skills: [],
      });
      expect(snapshot?.unavailableReason).toContain("native-boundary-unqualified");

      // A changed candidate is reconciled, but can never acquire a native runtime.
      yield* mutator.reconcile({
        [instanceId]: {
          driver: CodexTypedSkillsDriver.driverKind,
          config: { candidate: { ...candidate, sourceCommit: "c".repeat(40) } },
        },
      });
      expect(yield* registry.getInstance(instanceId)).toBeUndefined();
      expect(yield* registry.listInstances).toEqual([]);
      expect((yield* registry.listUnavailable)[0]?.skills).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(unusedServices)),
);

it.effect("a build without this driver refuses instead of degrading to legacy Codex", () =>
  Effect.gen(function* () {
    const { registry } = yield* makeProviderInstanceRegistry<never>({
      drivers: [],
      configMap: {
        [instanceId]: { driver: CodexTypedSkillsDriver.driverKind, config: { candidate } },
      },
    });
    expect(yield* registry.listInstances).toEqual([]);
    expect((yield* registry.listUnavailable)[0]).toMatchObject({
      driver: "codex-typed-skills",
      availability: "unavailable",
      skills: [],
      models: [],
    });
  }).pipe(Effect.scoped, Effect.provide(unusedServices)),
);

it("rejects malformed immutable candidate references at the native config boundary", () => {
  for (const change of [
    { directory: "" },
    { sourceRepository: "untrusted/repository" },
    { sourceCommit: "main" },
    { admissionSha256: "not-a-digest" },
  ]) {
    expect(() => decodeSettings({ candidate: { ...candidate, ...change } })).toThrow();
  }
});

it.effect(
  "an explicit governed launch preserves its route and denies unsupported continuations and exec helpers",
  () =>
    Effect.gen(function* () {
      const source = {
        directory: "/synthetic/never-read/source",
        sourceCommit: "a".repeat(40),
        pythonPath: "python3",
        provider: "codex",
        principal: { id: "synthetic", emailSha256: "b".repeat(64) },
        generations: {},
      };
      const instance = yield* CodexTypedSkillsDriver.create({
        instanceId,
        displayName: undefined,
        enabled: false,
        environment: [],
        config: decodeSettings({ launch: { codex: { enabled: false }, source } }),
      });
      expect(instance.driverKind).toBe("codex-typed-skills");
      const snapshotForCwd = instance.snapshotForCwd;
      if (!snapshotForCwd) return yield* Effect.die("Governed driver is missing cwd discovery.");
      expect((yield* snapshotForCwd("/synthetic")).skills).toEqual([]);
      expect(
        (yield* instance.orchestrationAdapter.getCapabilities()).turns.supportsActiveSteering,
      ).toBe(false);
      expect((yield* instance.orchestrationAdapter.getCapabilities()).threads.canForkThread).toBe(
        false,
      );
      // No caller can bypass request admission by selecting the separate exec path.
      const failure = yield* Effect.exit(
        instance.textGeneration.generateThreadTitle({
          message: "synthetic",
          cwd: "/synthetic",
          modelSelection: { instanceId, model: "fixture-model" },
        }),
      );
      expect(failure._tag).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(unusedServices)),
);
