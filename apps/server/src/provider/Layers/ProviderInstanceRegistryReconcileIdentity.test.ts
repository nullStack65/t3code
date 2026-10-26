import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  defaultProviderContinuationIdentity,
  type AnyProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  deriveProviderInstanceConfigMap,
  deriveProviderInstanceIdentity,
  reconcileProviderInstanceSettings,
} from "./ProviderInstanceRegistryHydration.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

/**
 * Reconcile-identity regression: host policy that gates how a Codex instance
 * is built (today the Codex session guard) must rebuild that instance when it
 * changes, and the rebuild must retire the previous readers before the refusal
 * is published. Drivers here are synthetic: they never spawn a provider, and
 * refusal is decided by the test the same way the real driver decides it from
 * host settings.
 */

const CODEX = ProviderDriverKind.make("codex");
const CODEX_SKILLS = ProviderDriverKind.make("codex-typed-skills");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

const CODEX_ID = ProviderInstanceId.make("codex");
const CODEX_SKILLS_ID = ProviderInstanceId.make("codex-typed-skills");
const CLAUDE_ID = ProviderInstanceId.make("claudeAgent");

interface SyntheticDriverState {
  /** Mirrors the driver reading host settings when it materializes. */
  readonly refuse: Ref.Ref<boolean>;
  readonly created: Ref.Ref<number>;
  readonly retired: Ref.Ref<number>;
  /** Retirements already observed each time `create` ran. */
  readonly observedRetirementsAtCreate: Ref.Ref<ReadonlyArray<number>>;
}

const makeSyntheticDriver = (
  kind: ProviderDriverKind,
  displayName: string,
  state: SyntheticDriverState,
): AnyProviderDriver<never> => ({
  driverKind: kind,
  metadata: { displayName },
  configSchema: Schema.Unknown,
  defaultConfig: () => undefined,
  create: ({ instanceId }) =>
    Effect.gen(function* () {
      yield* Ref.update(state.created, (count) => count + 1);
      const retiredBefore = yield* Ref.get(state.retired);
      yield* Ref.update(state.observedRetirementsAtCreate, (seen) => [...seen, retiredBefore]);
      const refuse = yield* Ref.get(state.refuse);
      if (refuse) {
        return yield* new ProviderDriverError({
          driver: kind,
          instanceId,
          detail:
            "Codex session guard refused the launch [provider-descriptor-retention-unqualified]",
        });
      }
      yield* Effect.addFinalizer(() => Ref.update(state.retired, (count) => count + 1));
      return {
        instanceId,
        driverKind: kind,
        continuationIdentity: defaultProviderContinuationIdentity({
          driverKind: kind,
          instanceId,
        }),
        displayName,
        enabled: true,
        // The registry never reads these in this test; it only decides
        // whether an entry is live, replaced, or unavailable.
        snapshot: {
          resolveMaintenance: () =>
            Effect.succeed({ update: null } as ProviderMaintenanceCapabilities),
          getSnapshot: Effect.succeed({} as ServerProvider),
          refresh: Effect.succeed({} as ServerProvider),
          streamChanges: Stream.empty,
          applyUsageLimits: () => Effect.void,
        },
        adapter: {} as ProviderAdapterShape<ProviderAdapterError>,
        textGeneration: {} as TextGeneration.TextGeneration["Service"],
      } satisfies ProviderInstance;
    }),
});

const makeDriverState = Effect.gen(function* () {
  return {
    refuse: yield* Ref.make(false),
    created: yield* Ref.make(0),
    retired: yield* Ref.make(0),
    observedRetirementsAtCreate: yield* Ref.make<ReadonlyArray<number>>([]),
  } satisfies SyntheticDriverState;
});

const settingsWith = (patch: ServerSettingsPatch): ServerSettings =>
  applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch);

// Explicit instances keep the derived map to the two synthetic drivers; a
// legacy `providers` blob would also synthesize envelopes for built-ins this
// registry does not register.
const CODEX_AND_CLAUDE_INSTANCES: ServerSettingsPatch = {
  providerInstances: {
    [CODEX_ID]: { driver: CODEX, config: {} },
    [CLAUDE_ID]: { driver: CLAUDE, config: {} },
  },
};

const ENFORCE_GUARD: ServerSettingsPatch = { codexSessionGuard: { mode: "enforce" } };
const DISABLE_GUARD: ServerSettingsPatch = { codexSessionGuard: { mode: "disabled" } };

it.effect(
  "retires a live Codex instance before publishing the guard refusal, and leaves other providers alone",
  () =>
    Effect.gen(function* () {
      const codexState = yield* makeDriverState;
      const claudeState = yield* makeDriverState;
      const drivers = [
        makeSyntheticDriver(CODEX, "Codex", codexState),
        makeSyntheticDriver(CLAUDE, "Claude", claudeState),
      ] as const;

      const bootSettings = settingsWith(CODEX_AND_CLAUDE_INSTANCES);
      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers,
        configMap: deriveProviderInstanceConfigMap(bootSettings),
        identity: deriveProviderInstanceIdentity(bootSettings),
      });

      const liveCodex = yield* registry.getInstance(CODEX_ID);
      const liveClaude = yield* registry.getInstance(CLAUDE_ID);
      expect(liveCodex).toBeDefined();
      expect(liveClaude).toBeDefined();

      // Enroll the host while both instances are live.
      yield* Ref.set(codexState.refuse, true);
      yield* reconcileProviderInstanceSettings(
        mutator,
        settingsWith({ ...CODEX_AND_CLAUDE_INSTANCES, ...ENFORCE_GUARD }),
      );

      expect(yield* registry.getInstance(CODEX_ID)).toBeUndefined();
      const unavailable = yield* registry.listUnavailable;
      const codexRefusal = unavailable.find((entry) => entry.instanceId === CODEX_ID);
      expect(codexRefusal).toBeDefined();
      expect(codexRefusal!.unavailableReason).toContain("Codex session guard refused");
      expect(codexRefusal!.unavailableReason).toContain(
        "provider-descriptor-retention-unqualified",
      );

      // The previous live instance was retired, and the replacement ran only
      // after that retirement (reconcile closes before it rebuilds).
      expect(yield* Ref.get(codexState.retired)).toBe(1);
      expect(yield* Ref.get(codexState.observedRetirementsAtCreate)).toEqual([0, 1]);

      // A guard change is not a reason to restart an unrelated provider.
      expect(yield* registry.getInstance(CLAUDE_ID)).toBe(liveClaude);
      expect(yield* Ref.get(claudeState.created)).toBe(1);
      expect(yield* Ref.get(claudeState.retired)).toBe(0);
    }).pipe(Effect.scoped),
);

it.effect("restores the legacy Codex path when the guard is disabled again", () =>
  Effect.gen(function* () {
    const codexState = yield* makeDriverState;
    const drivers = [makeSyntheticDriver(CODEX, "Codex", codexState)] as const;

    const enabled = settingsWith(CODEX_AND_CLAUDE_INSTANCES);
    const { registry, mutator } = yield* makeProviderInstanceRegistry({
      drivers,
      configMap: deriveProviderInstanceConfigMap(enabled),
      identity: deriveProviderInstanceIdentity(enabled),
    });
    const firstLive = yield* registry.getInstance(CODEX_ID);

    yield* Ref.set(codexState.refuse, true);
    yield* reconcileProviderInstanceSettings(
      mutator,
      settingsWith({ ...CODEX_AND_CLAUDE_INSTANCES, ...ENFORCE_GUARD }),
    );
    expect(yield* registry.getInstance(CODEX_ID)).toBeUndefined();

    yield* Ref.set(codexState.refuse, false);
    yield* reconcileProviderInstanceSettings(
      mutator,
      settingsWith({ ...CODEX_AND_CLAUDE_INSTANCES, ...DISABLE_GUARD }),
    );

    const recovered = yield* registry.getInstance(CODEX_ID);
    expect(recovered).toBeDefined();
    expect(recovered).not.toBe(firstLive);
    const unavailableAfterRecovery = yield* registry.listUnavailable;
    expect(unavailableAfterRecovery.filter((entry) => entry.instanceId === CODEX_ID)).toEqual([]);
    expect(yield* Ref.get(codexState.created)).toBe(3);
    // First instance retired on enforcement, the refused build never ran a
    // finalizer, and recovery built a fresh instance.
    expect(yield* Ref.get(codexState.retired)).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("does not rebuild Codex for settings changes outside the guard policy", () =>
  Effect.gen(function* () {
    const codexState = yield* makeDriverState;
    const drivers = [makeSyntheticDriver(CODEX, "Codex", codexState)] as const;

    const enabled = settingsWith(CODEX_AND_CLAUDE_INSTANCES);
    const { registry, mutator } = yield* makeProviderInstanceRegistry({
      drivers,
      configMap: deriveProviderInstanceConfigMap(enabled),
      identity: deriveProviderInstanceIdentity(enabled),
    });
    const live = yield* registry.getInstance(CODEX_ID);

    yield* reconcileProviderInstanceSettings(
      mutator,
      settingsWith({ ...CODEX_AND_CLAUDE_INSTANCES, generateThreadTitles: false }),
    );

    expect(yield* registry.getInstance(CODEX_ID)).toBe(live);
    expect(yield* Ref.get(codexState.created)).toBe(1);
    expect(yield* Ref.get(codexState.retired)).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("rebuilds a refusing Codex instance when only a guard reference changes", () =>
  Effect.gen(function* () {
    const codexState = yield* makeDriverState;
    const drivers = [makeSyntheticDriver(CODEX, "Codex", codexState)] as const;
    yield* Ref.set(codexState.refuse, true);

    const enforced = settingsWith({
      ...CODEX_AND_CLAUDE_INSTANCES,
      ...ENFORCE_GUARD,
      codexSessionGuard: { mode: "enforce", interpreter: "/usr/bin/python3" },
    });
    const { registry, mutator } = yield* makeProviderInstanceRegistry({
      drivers,
      configMap: deriveProviderInstanceConfigMap(enforced),
      identity: deriveProviderInstanceIdentity(enforced),
    });
    expect(yield* registry.getInstance(CODEX_ID)).toBeUndefined();

    // Fixing a misconfigured reference must re-run the gate so the operator
    // sees the new diagnosis instead of a stale one.
    yield* reconcileProviderInstanceSettings(
      mutator,
      settingsWith({
        ...CODEX_AND_CLAUDE_INSTANCES,
        ...ENFORCE_GUARD,
        codexSessionGuard: { mode: "enforce", interpreter: "/opt/reviewed/bin/python3" },
      }),
    );

    expect(yield* registry.getInstance(CODEX_ID)).toBeUndefined();
    expect(yield* Ref.get(codexState.created)).toBe(2);
  }).pipe(Effect.scoped),
);

it("scopes the guard fingerprint to Codex-built instances", () => {
  const settings = settingsWith({
    providerInstances: {
      [CODEX_ID]: { driver: CODEX, config: {} },
      [CODEX_SKILLS_ID]: { driver: CODEX_SKILLS, config: {} },
      [CLAUDE_ID]: { driver: CLAUDE, config: {} },
    },
    ...ENFORCE_GUARD,
  });
  const enforced = deriveProviderInstanceIdentity(settings);
  expect([...enforced.keys()].sort()).toEqual([String(CODEX_ID), String(CODEX_SKILLS_ID)].sort());
  expect(new Set(enforced.values()).size).toBe(1);

  const unguarded = deriveProviderInstanceIdentity(
    settingsWith({
      providerInstances: {
        [CODEX_ID]: { driver: CODEX, config: {} },
        [CODEX_SKILLS_ID]: { driver: CODEX_SKILLS, config: {} },
        [CLAUDE_ID]: { driver: CLAUDE, config: {} },
      },
      ...DISABLE_GUARD,
    }),
  );
  expect(unguarded.has(CLAUDE_ID)).toBe(false);
  expect(unguarded.get(CODEX_ID)).not.toBe(enforced.get(CODEX_ID));

  const unrelatedChange = deriveProviderInstanceIdentity(
    settingsWith({
      providerInstances: {
        [CODEX_ID]: { driver: CODEX, config: {} },
        [CODEX_SKILLS_ID]: { driver: CODEX_SKILLS, config: {} },
        [CLAUDE_ID]: { driver: CLAUDE, config: {} },
      },
      ...ENFORCE_GUARD,
      generateThreadTitles: false,
    }),
  );
  expect(unrelatedChange.get(CODEX_ID)).toBe(enforced.get(CODEX_ID));
  expect(unrelatedChange.get(CODEX_SKILLS_ID)).toBe(enforced.get(CODEX_SKILLS_ID));
});
