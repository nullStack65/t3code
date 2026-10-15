import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { ProviderAdapterRegistryLive } from "../Layers/ProviderAdapterRegistry.ts";
import { makeProviderInstanceRegistry } from "../Layers/ProviderInstanceRegistryLive.ts";
import { deriveProviderInstanceConfigMap } from "../Layers/ProviderInstanceRegistryHydration.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  CodexTypedSkillAdmissionRefused,
  CodexTypedSkillsDriver,
  CodexTypedSkillsSettings,
} from "./CodexTypedSkillsDriver.ts";

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
    }).pipe(Effect.scoped),
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

      const adapters = yield* ProviderAdapterRegistry.pipe(
        Effect.provide(ProviderAdapterRegistryLive),
        Effect.provideService(ProviderInstanceRegistry, registry),
      );
      expect(yield* Effect.flip(adapters.getByInstance(instanceId))).toMatchObject({
        _tag: "ProviderUnsupportedError",
      });
      expect(yield* Effect.flip(adapters.getInstanceInfo(instanceId))).toMatchObject({
        _tag: "ProviderUnsupportedError",
      });

      // A changed candidate is reconciled, but can never resume retained context.
      yield* mutator.reconcile({
        [instanceId]: {
          driver: CodexTypedSkillsDriver.driverKind,
          config: { candidate: { ...candidate, sourceCommit: "c".repeat(40) } },
        },
      });
      expect(yield* registry.getInstance(instanceId)).toBeUndefined();
      expect(yield* registry.listInstances).toEqual([]);
      expect((yield* registry.listUnavailable)[0]?.skills).toEqual([]);
    }).pipe(Effect.scoped),
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
  }).pipe(Effect.scoped),
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
