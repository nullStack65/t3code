/**
 * OmpDriver — `ProviderDriver` for the Oh My Pi (`omp`) runtime.
 *
 * Oh My Pi exposes an ACP-based CLI (`omp acp`). Like OpenCode it is a meta
 * provider: the model catalog is whatever the user configured inside omp and
 * is discovered dynamically from the ACP `model` config option during the
 * managed provider status check — nothing is hardcoded.
 *
 * Text generation is supported via the ACP runtime — `makeOmpTextGeneration`
 * drives `runtime.prompt` with a structured-output schema and collects the
 * agent's `agent_message_chunk` stream into a single JSON blob.
 *
 * @module provider/Drivers/OmpDriver
 */
import {
  OmpSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderWorkspaceSnapshot,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOmpTextGeneration } from "../../textGeneration/OmpTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import {
  buildInitialOmpProviderSnapshot,
  checkOmpProviderStatus,
  enrichOmpSnapshot,
} from "../Layers/OmpProvider.ts";
import { discoverOmpCommandCatalog } from "./OmpCommands.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeCachedProviderMaintenanceResolution,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import { makeOmpMaintenanceResolver, appendOmpWorkspaceSnapshot } from "./OmpMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

const DRIVER_KIND = ProviderDriverKind.make("omp");

export type OmpDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Oh My Pi",
    supportsMultipleInstances: true,
  },
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => decodeOmpSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies OmpSettings;

      // omp is its own updater (`omp update`, latest from `omp update
      // --check`), so the resolved executable is its own update command. A
      // binary that cannot be resolved stays manual-only: nothing to update,
      // not "whatever is on PATH".
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(makeOmpMaintenanceResolver(), {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        ),
      );
      // Skills discovered per workspace. The adapter reads names from here to
      // rewrite `$name` mentions, so a turn never spawns its own probe.
      const skillNamesByCwd = new Map<string, ReadonlySet<string>>();
      const adapter = yield* makeOmpAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
        resolveSkillNames: (cwd) => skillNamesByCwd.get(cwd) ?? new Set<string>(),
      });
      const textGeneration = yield* makeOmpTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkOmpProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OmpSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialOmpProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        // Model catalog and capabilities come exclusively from the probe ACP
        // session's configOptions during provider checks.
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichOmpSnapshot({
                settings: settings.provider,
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                publishSnapshot,
                stampIdentity,
                httpClient,
              }),
            ),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Oh My Pi snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      // Per-workspace command catalogs. The composer only offers a workspace's
      // menus once its snapshot is recorded, so every refresh retains the
      // workspaces visited earlier in the session (Antigravity precedent).
      let retainedWorkspaceSnapshots: ReadonlyArray<ServerProviderWorkspaceSnapshot> = [];
      const snapshotForCwd = (workspaceCwd: string) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              discoverOmpCommandCatalog(effectiveConfig, processEnv, workspaceCwd).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: `Failed to discover Oh My Pi commands for '${workspaceCwd}'`,
                      cause,
                    }),
                ),
              ),
            ]).pipe(
              Effect.tap(([, catalog]) =>
                Effect.sync(() => {
                  skillNamesByCwd.set(
                    workspaceCwd,
                    new Set(catalog.skills.map((skill) => skill.name)),
                  );
                }),
              ),
              Effect.flatMap(([machineSnapshot, catalog]) =>
                Effect.map(DateTime.now, (now) => {
                  retainedWorkspaceSnapshots = appendOmpWorkspaceSnapshot(
                    retainedWorkspaceSnapshots,
                    {
                      cwd: workspaceCwd,
                      checkedAt: DateTime.formatIso(now),
                      slashCommands: catalog.slashCommands,
                      skills: catalog.skills,
                    },
                  );
                  return {
                    ...machineSnapshot,
                    skills: catalog.skills,
                    slashCommands: catalog.slashCommands,
                    workspaceSnapshots: [...retainedWorkspaceSnapshots],
                  };
                }),
              ),
            );

      // A user who configures a new upstream inside omp re-probes the catalog
      // without restarting T3: the managed refresh re-runs the ACP discovery
      // probe and publishes when the catalog moved.
      const refreshModels: NonNullable<ProviderInstance["refreshModels"]> = Effect.fn(
        "OmpDriver.refreshModels",
      )(() => snapshot.refresh.pipe(Effect.asVoid));

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        snapshotForCwd,
        refreshModels,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
