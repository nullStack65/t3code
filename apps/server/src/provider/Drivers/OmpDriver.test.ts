// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { createProviderVersionAdvisory } from "../providerMaintenance.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { OmpDriver } from "./OmpDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-omp-driver-maintenance-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected omp HTTP request in driver test")),
    ),
  ),
);

const resolveMockAgentPath = Effect.fn("resolveMockAgentPath")(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url));
});

const catalogCommands = [
  { name: "skill:deploy", description: "Deploy the app" },
  { name: "share", description: "Share the session" },
];

/**
 * Fake omp answering every subcommand the driver probes: `--version` for the
 * status check, `update --check` for maintenance, `--mode rpc` for the
 * command catalog, and `acp` delegated to the mock agent. The ACP shapes flip
 * through a flag file so a refresh can publish a changed catalog.
 */
function fakeOmpSource(input: {
  readonly mockAgentPath: string;
  readonly checkOutput: string;
  readonly ompShapesEnv: string;
}): string {
  return [
    'import { existsSync } from "node:fs";',
    'import { pathToFileURL } from "node:url";',
    "const args = process.argv.slice(2);",
    'if (args[0] === "--version") {',
    '  process.stdout.write("omp/18.1.18\\n");',
    "  process.exit(0);",
    "}",
    'if (args[0] === "update" && args[1] === "--check") {',
    `  process.stdout.write(${JSON.stringify(input.checkOutput)});`,
    "  process.exit(0);",
    "}",
    'if (args[0] === "--mode") {',
    `  process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: "available_commands_update", commands: catalogCommands })}\n`)});`,
    "  process.exit(0);",
    "}",
    'if (args[0] === "acp") {',
    `  ${input.ompShapesEnv}`,
    `  await import(pathToFileURL(${JSON.stringify(input.mockAgentPath)}).href);`,
    "} else {",
    '  process.stderr.write(`unexpected args: ${args.join(" ")}\\n`);',
    "  process.exit(11);",
    "}",
    "",
  ].join("\n");
}

const makeFakeOmp = Effect.fn("makeFakeOmp")(function* (options: {
  readonly prefix: string;
  readonly checkOutput: string;
  readonly ompShapesEnv?: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const mockAgentPath = yield* resolveMockAgentPath();
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: options.prefix });
  return writeFakeCli({
    directory,
    name: "fake-omp",
    source: fakeOmpSource({
      mockAgentPath,
      checkOutput: options.checkOutput,
      ompShapesEnv: options.ompShapesEnv ?? 'process.env.T3_ACP_OMP_SHAPES = "1";',
    }),
  });
});

const createTestInstance = (
  instanceId: string,
  input: { readonly binaryPath: string; readonly enabled: boolean },
) =>
  OmpDriver.create({
    instanceId: ProviderInstanceId.make(instanceId),
    displayName: "omp test",
    enabled: input.enabled,
    environment: [],
    config: { ...OmpDriver.defaultConfig(), binaryPath: input.binaryPath },
  });

it.layer(testLayer)("OmpDriver", (it) => {
  it.effect("advertises omp's own update command with the --check latest version", () =>
    Effect.gen(function* () {
      const fakePath = yield* makeFakeOmp({
        prefix: "t3-omp-driver-update-",
        checkOutput: "Current version: 18.1.18\nNew version available: 18.1.21\n",
      });
      const instance = yield* createTestInstance("omp-update-check", {
        binaryPath: fakePath,
        enabled: false,
      });

      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.update).toMatchObject({ args: ["update"], lockKey: "omp" });
      expect(capabilities.update?.executable).toContain("fake-omp");
      expect(capabilities.update?.command).toContain("update");
      expect(capabilities.latestVersion).toBe("18.1.21");
      expect(
        createProviderVersionAdvisory({
          driver: OmpDriver.driverKind,
          currentVersion: "18.1.18",
          latestVersion: capabilities.latestVersion ?? null,
          maintenanceCapabilities: capabilities,
        }),
      ).toMatchObject({ status: "behind_latest", canUpdate: true });
    }).pipe(Effect.scoped),
  );

  it.effect("reports current when update --check announces no new version", () =>
    Effect.gen(function* () {
      const fakePath = yield* makeFakeOmp({
        prefix: "t3-omp-driver-current-",
        checkOutput: "Current version: 18.1.21\nAlready up to date.\n",
      });
      const instance = yield* createTestInstance("omp-update-current", {
        binaryPath: fakePath,
        enabled: false,
      });

      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.update).toMatchObject({ args: ["update"], lockKey: "omp" });
      expect(capabilities.latestVersion).toBe("18.1.21");
      expect(
        createProviderVersionAdvisory({
          driver: OmpDriver.driverKind,
          currentVersion: "18.1.21",
          latestVersion: capabilities.latestVersion ?? null,
          maintenanceCapabilities: capabilities,
        }),
      ).toMatchObject({ status: "current", canUpdate: true });
    }).pipe(Effect.scoped),
  );

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const instance = yield* createTestInstance("omp-update-missing", {
        binaryPath: NodePath.join(NodeOS.tmpdir(), "t3-omp-missing", "omp"),
        enabled: false,
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("records a workspace snapshot per cwd and keeps earlier workspaces", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fakePath = yield* makeFakeOmp({
        prefix: "t3-omp-driver-workspace-",
        checkOutput: "Current version: 18.1.18\n",
      });
      const instance = yield* createTestInstance("omp-workspace", {
        binaryPath: fakePath,
        enabled: true,
      });
      const snapshotForCwd = instance.snapshotForCwd;
      if (!snapshotForCwd)
        return yield* Effect.die("OmpDriver does not expose workspace snapshots.");
      const workspaceA = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-workspace-a-" });
      const workspaceB = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-workspace-b-" });
      const first = yield* snapshotForCwd(workspaceA);
      expect(first.skills.map((skill) => skill.name)).toEqual(["deploy"]);
      expect(first.slashCommands.map((command) => command.name)).toEqual(["share"]);
      expect(first.workspaceSnapshots?.map((snapshot) => snapshot.cwd)).toEqual([workspaceA]);
      expect(first.workspaceSnapshots?.[0]?.skills.map((skill) => skill.name)).toEqual(["deploy"]);
      expect(first.workspaceSnapshots?.[0]?.slashCommands.map((command) => command.name)).toEqual([
        "share",
      ]);

      const second = yield* snapshotForCwd(workspaceB);
      expect(second.workspaceSnapshots?.map((snapshot) => snapshot.cwd)).toEqual([
        workspaceA,
        workspaceB,
      ]);

      const third = yield* snapshotForCwd(workspaceA);
      expect(third.workspaceSnapshots?.map((snapshot) => snapshot.cwd)).toEqual([
        workspaceB,
        workspaceA,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("refreshModels re-probes and publishes a changed catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-driver-refresh-" });
      const shapesFlagPath = path.join(root, "omp-shapes");
      const mockAgentPath = yield* resolveMockAgentPath();
      const fakePath = writeFakeCli({
        directory: path.join(root, "bin"),
        name: "fake-omp",
        source: fakeOmpSource({
          mockAgentPath,
          checkOutput: "Current version: 18.1.18\n",
          // @effect-diagnostics-next-line preferSchemaOverJson:off - quoting a path into the fake CLI source.
          ompShapesEnv: `if (existsSync(${JSON.stringify(shapesFlagPath)})) { process.env.T3_ACP_OMP_SHAPES = "1"; } else { delete process.env.T3_ACP_OMP_SHAPES; }`,
        }),
      });
      const instance = yield* createTestInstance("omp-refresh", {
        binaryPath: fakePath,
        enabled: true,
      });
      // The managed snapshot probes in the background, so await one refresh
      // for the baseline catalog instead of racing the initial probe.
      const baseline = yield* instance.snapshot.refresh;
      const before = baseline.models.map((model) => model.slug);
      expect([...before].sort()).toEqual(
        [
          "composer-2",
          "composer-2[fast=true]",
          "default",
          "gpt-5.3-codex[reasoning=medium,fast=false]",
        ].sort(),
      );

      yield* fs.writeFileString(shapesFlagPath, "omp\n");
      const refresh = instance.refreshModels;
      if (!refresh) return yield* Effect.die("OmpDriver does not expose model refresh.");
      yield* refresh();

      const after = (yield* instance.snapshot.getSnapshot).models.map((model) => model.slug);
      expect([...after].sort()).toEqual(
        ["anthropic/claude-opus-4-6", "openai/gpt-5.4", "zhipu-coding-plan/glm-5.3"].sort(),
      );
      expect(after).not.toEqual(before);
    }).pipe(Effect.scoped),
  );
});
