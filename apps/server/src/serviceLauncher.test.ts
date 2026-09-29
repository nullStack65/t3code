// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics preferSchemaOverJson:off -- Builds a fake child source from string fragments.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

import packageJson from "../package.json" with { type: "json" };

import {
  Launcher,
  type LauncherControlOptions,
  readServiceState,
  requestGracefulChildStop,
  writeServiceState,
} from "./serviceLauncher.ts";
import {
  compareExactServiceVersions,
  decodeServiceState,
  isExactServiceVersion,
  SERVICE_CONTROL_REQUEST_FILE,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STOP_MARKER_FILE,
} from "./cloud/serviceProtocol.ts";

it("accepts only exact semantic versions", () => {
  for (const version of ["0.0.0", "1.2.3", "1.2.3-alpha.1", "1.2.3-0", "1.2.3+001"]) {
    assert.isTrue(isExactServiceVersion(version), version);
  }
  for (const version of ["latest", "01.2.3", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+."]) {
    assert.isFalse(isExactServiceVersion(version), version);
  }
});

it("orders exact semantic versions without treating build metadata as precedence", () => {
  assert.equal(compareExactServiceVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareExactServiceVersions("1.2.4", "1.2.3"), 1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha.1", "2.0.0-alpha.2"), -1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha.2", "2.0.0-alpha.beta"), -1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha-beta", "2.0.0-alpha-alpha"), 1);
  assert.equal(compareExactServiceVersions("2.0.0", "2.0.0-rc.1"), 1);
  assert.equal(compareExactServiceVersions("2.0.0+one", "2.0.0+two"), 0);
});

it("rejects contradictory service state", () => {
  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "0.0.31",
      update: {
        id: "update-1",
        fromVersion: "0.0.30",
        targetVersion: "0.0.32",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      },
    }),
  );

  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "1.0.0",
      update: {
        id: "update-3",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        status: "pending",
      },
    }),
  );

  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "1.0.0",
      update: {
        id: "update-2",
        fromVersion: "1.0.0",
        targetVersion: "0.9.0",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      },
    }),
  );
});

// A pinned runtime is an executable at <versionDir>/t3 (or t3.exe on Windows).
// The tests stand one up as a Node script so the launcher spawns it the way it
// spawns the real single-executable, IPC channel included. The script is not a
// native Windows executable, so the OS cannot honor its shebang there; on
// Windows the launcher runs it through the injected Node interpreter instead.
const writeFakeRuntime = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  versionDir: string,
  childSource: string,
) =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const entryPath = path.join(versionDir, platform === "win32" ? "t3.exe" : "t3");
    yield* fs.makeDirectory(versionDir, { recursive: true });
    yield* fs.writeFileString(entryPath, `#!${process.execPath}\n${childSource}`);
    yield* fs.chmod(entryPath, 0o755);
    yield* fs.writeFileString(
      path.join(versionDir, ".install-complete"),
      `${path.basename(versionDir)}\n`,
    );
    return entryPath;
  });

// The test runtime is a script rather than the production native executable, so
// Windows needs an explicit interpreter. POSIX keeps the launcher's direct-exec
// path, so no platform-specific behavior is baked into the launcher itself.
const launcherOptions = (control?: LauncherControlOptions) =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    if (platform !== "win32") return control === undefined ? {} : { control };
    return {
      ...(control === undefined ? {} : { control }),
      runtimeInterpreter: process.execPath,
    };
  });

it.layer(NodeServices.layer)("service state persistence", (it) => {
  it.effect("durably replaces and strictly reads one state document", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-test-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const state = {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "0.0.31",
      } as const;

      yield* Effect.promise(() => writeServiceState(statePath, state));
      assert.deepEqual(yield* Effect.promise(() => readServiceState(statePath)), state);
    }),
  );

  it.effect("a fresh launcher clears a restart deferred by t3 update", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-restart-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const restartPending = path.join(root, "runtime", SERVICE_RESTART_PENDING_FILE);
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        "setInterval(() => {}, 1_000);\n",
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const run = () =>
        Effect.gen(function* () {
          const launcher = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
            yield* launcherOptions(),
          );
          const running = launcher.run();
          yield* Effect.promise(() => launcher.stop("SIGTERM"));
          yield* Effect.promise(() => running);
        });

      // A launcher that is still the old version leaves a marker that waits
      // for a newer one.
      yield* fs.writeFileString(restartPending, "1.0.1\n");
      yield* run();
      assert.isTrue(yield* fs.exists(restartPending));

      // Whoever restarted the service, the launcher now runs what the unit
      // names, so the deferred-restart marker is gone.
      yield* fs.writeFileString(restartPending, "1.0.0\n");
      yield* run();
      assert.isFalse(yield* fs.exists(restartPending));
    }),
  );

  it.effect("serializes shutdown with launcher recovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-stop-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        "setInterval(() => {}, 1_000);\n",
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        yield* launcherOptions(),
      );
      const running = launcher.run();
      const stopping = launcher.stop("SIGTERM");
      // An explicit stop leaves the marker that tells a child shutting down
      // mid-update that no replacement server is coming. It is present as
      // soon as stop() returns its promise, before queued transitions run.
      assert.isTrue(yield* fs.exists(path.join(root, "runtime", SERVICE_STOP_MARKER_FILE)));
      yield* Effect.promise(() => stopping);
      yield* Effect.promise(() => running);
    }),
  );

  it.effect("commits only after the trial reports prepared", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-flow-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "before trial");
      // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds a path in fake child source.
      const encodedDatabasePath = JSON.stringify(databasePath);
      const childSource = `
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  process.send({ type: "prepared", updateId: context.update.id });
  process.on("message", (message) => {
    if (message.type === "committed") process.exit(0);
  });
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        yield* launcherOptions(),
      );
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.1.0");
      assert.equal(state.update?.status, "committed");
    }),
  );

  it.effect("rolls back a trial that reports the wrong update ID", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-rollback-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "before trial");
      // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds a path in fake child source.
      const encodedDatabasePath = JSON.stringify(databasePath);
      const childSource = `
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  process.send({ type: "prepared", updateId: "wrong-update" });
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        yield* launcherOptions(),
      );
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.equal(state.update?.status, "rolled-back");
      assert.equal(
        state.update?.status === "rolled-back" ? state.update.reason : undefined,
        "invalid-prepared",
      );
    }),
  );

  it.effect("restores the database when a migrating trial exits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-db-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const original = "database before migration";
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, original);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds a path in fake child source.
      const encodedDatabasePath = JSON.stringify(databasePath);
      const childSource = `
import { writeFileSync } from "node:fs";
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  writeFileSync(context.update.dbPath, "database after migration");
  writeFileSync(context.update.dbPath + "-wal", "trial wal");
  writeFileSync(context.update.dbPath + "-shm", "trial shm");
  process.exit(1);
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        yield* launcherOptions(),
      );
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.equal(state.update?.status, "rolled-back");
      assert.equal(yield* fs.readFileString(databasePath), original);
      assert.isFalse(yield* fs.exists(`${databasePath}-wal`));
      assert.isFalse(yield* fs.exists(`${databasePath}-shm`));
      const updateId = state.update?.id;
      assert.isDefined(updateId);
      assert.isFalse(yield* fs.exists(path.join(root, "runtime", "db-backup", updateId)));
    }),
  );
});

it.layer(NodeServices.layer)("whole-service graceful stop over IPC", (it) => {
  it.effect("waits for the managed child's own exit before force-termination", () =>
    Effect.gen(function* () {
      // POSIX keeps its signal-driven finalizer path; the IPC drain is the
      // Windows path where a signal would be a hard kill. The production helper
      // is exercised against a real Node child at the real IPC boundary.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-graceful-" });
      const drainMarker = path.join(root, "drained.txt");
      // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds a path in the child source.
      const encodedDrainMarker = JSON.stringify(drainMarker);
      const childSource =
        `const { writeFileSync } = require("node:fs");\n` +
        `process.on("message", (message) => {\n` +
        `  if (message && message.type === "stop") {\n` +
        `    setTimeout(() => {\n` +
        `      writeFileSync(${encodedDrainMarker}, "drained");\n` +
        `      process.send({ type: "stopped", requestId: message.requestId });\n` +
        `      process.exit(0);\n` +
        `    }, 25);\n` +
        `  }\n` +
        `});\n` +
        `setInterval(() => {}, 1_000);\n`;
      const child = NodeChildProcess.spawn(process.execPath, ["-e", childSource], {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      yield* Effect.promise(() => new Promise<void>((r) => child.once("spawn", () => r())));
      const outcome = yield* Effect.promise(() => requestGracefulChildStop(child, "req-1"));

      // The child ran its own drain before the helper resolved, and the helper
      // only resolved on the real exit, not the earlier acknowledgement.
      assert.deepEqual(outcome, { status: "exited", acknowledged: true });
      assert.isTrue(yield* fs.exists(drainMarker));
    }),
  );

  it.effect("does not resolve on an early acknowledgement while resources still drain", () =>
    Effect.gen(function* () {
      const childSource =
        `process.on("message", (message) => {\n` +
        `  if (message && message.type === "stop") {\n` +
        `    process.send({ type: "stopped", requestId: message.requestId });\n` +
        `    setTimeout(() => process.exit(0), 300);\n` +
        `  }\n` +
        `});\n` +
        `setInterval(() => {}, 1_000);\n`;
      const child = NodeChildProcess.spawn(process.execPath, ["-e", childSource], {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      yield* Effect.promise(() => new Promise<void>((r) => child.once("spawn", () => r())));
      const started = Date.now();
      const outcome = yield* Effect.promise(() => requestGracefulChildStop(child, "req-1"));
      // The acknowledgement arrived almost immediately, but the helper waited
      // for the exit ~300 ms later instead of authorizing a force kill.
      assert.deepEqual(outcome, { status: "exited", acknowledged: true });
      assert.isAtLeast(Date.now() - started, 250);
    }),
  );

  it.effect("ignores an acknowledgement for a different request", () =>
    Effect.gen(function* () {
      const childSource =
        `process.on("message", (message) => {\n` +
        `  if (message && message.type === "stop") {\n` +
        `    process.send({ type: "stopped", requestId: "some-other-request" });\n` +
        `    setTimeout(() => process.exit(0), 50);\n` +
        `  }\n` +
        `});\n` +
        `setInterval(() => {}, 1_000);\n`;
      const child = NodeChildProcess.spawn(process.execPath, ["-e", childSource], {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      yield* Effect.promise(() => new Promise<void>((r) => child.once("spawn", () => r())));
      const outcome = yield* Effect.promise(() => requestGracefulChildStop(child, "req-1"));
      assert.deepEqual(outcome, { status: "exited", acknowledged: false });
    }),
  );

  it.effect("does not wait for a child without a live IPC channel", () =>
    Effect.gen(function* () {
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1_000);"],
        {
          stdio: ["ignore", "ignore", "inherit"],
        },
      );
      yield* Effect.promise(() => new Promise<void>((r) => child.once("spawn", () => r())));
      // No `ipc` stdio: the helper must report an unavailable channel without
      // driving a drain so the caller falls back to force-termination.
      const outcome = yield* Effect.promise(() => requestGracefulChildStop(child, "req-1"));
      assert.deepEqual(outcome, { status: "channel-unavailable" });
      child.kill();
    }),
  );

  it.effect(
    "drains the real managed shutdown layer, with a delayed finalizer, through the launcher",
    () =>
      Effect.gen(function* () {
        // The launcher's IPC drain branch is Windows-only in production. This
        // drives that exact production transition on this host and runs a child
        // that loads the *real* `managedShutdownLayer` from the server source,
        // then adds a delayed application finalizer. The launcher must wait for
        // the real exit (after the delayed finalizer), never an early hint.
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-service-launcher-realdrain-",
        });
        const statePath = path.join(root, "runtime", "service-state.json");
        const readyMarker = path.join(root, "child-ready.txt");
        const drainMarker = path.join(root, "drained.txt");
        const clientModule = new URL("./cloud/serviceLauncherClient.ts", import.meta.url).href;
        const require = NodeModule.createRequire(import.meta.url);
        const effectModule = NodeURL.pathToFileURL(require.resolve("effect/Effect")).href;
        const fiberModule = NodeURL.pathToFileURL(require.resolve("effect/Fiber")).href;
        const layerModule = NodeURL.pathToFileURL(require.resolve("effect/Layer")).href;
        const childSource =
          `const { writeFileSync } = require("node:fs");\n` +
          `(async () => {\n` +
          `  const client = await import(${JSON.stringify(clientModule)});\n` +
          `  const Effect = await import(${JSON.stringify(effectModule)});\n` +
          `  const Fiber = await import(${JSON.stringify(fiberModule)});\n` +
          `  const Layer = await import(${JSON.stringify(layerModule)});\n` +
          `  const program = Effect.scoped(Effect.gen(function* () {\n` +
          `    yield* Layer.build(client.managedShutdownLayer);\n` +
          `    yield* Effect.addFinalizer(() => Effect.promise(() => new Promise((resolve) => setTimeout(() => {\n` +
          `      writeFileSync(${JSON.stringify(drainMarker)}, "drained");\n` +
          `      resolve();\n` +
          `    }, 300))));\n` +
          `    yield* Effect.never;\n` +
          `  }));\n` +
          `  const fiber = Effect.runFork(program);\n` +
          `  process.on("SIGTERM", () => { Effect.runFork(Fiber.interrupt(fiber)); });\n` +
          `  writeFileSync(${JSON.stringify(readyMarker)}, "ready");\n` +
          `})();\n`;
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", packageJson.version),
          childSource,
        );
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: packageJson.version,
          }),
        );
        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
          {
            control: { instance: "instance-a", pollIntervalMs: 20 },
            gracefulIpcStop: true,
          },
        );
        const running = launcher.run();
        yield* Effect.promise(async () => {
          for (let attempt = 0; attempt < 500; attempt += 1) {
            if (NodeFS.existsSync(readyMarker)) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        });
        yield* fs.writeFileString(
          path.join(root, "runtime", SERVICE_CONTROL_REQUEST_FILE),
          JSON.stringify({
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            type: "stop",
            instance: "instance-a",
            requestId: "req-real",
          }),
        );
        yield* Effect.promise(() => running);

        // The real layer's message handler drove the child's own finalizer, which
        // wrote the marker after its delay, before the process actually exited.
        assert.isTrue(yield* fs.exists(drainMarker));
        assert.isTrue(yield* fs.exists(path.join(root, "runtime", SERVICE_STOP_MARKER_FILE)));
      }),
  );
});

it.layer(NodeServices.layer)("pinned runtime launch seam", (it) => {
  it.effect("runs a scripted runtime through the injected interpreter", () =>
    Effect.gen(function* () {
      // Windows cannot exec the script fixture through its shebang, so the
      // launcher runs it through an interpreter there. The same seam runs here
      // on every host, proving the Windows launch path drives the real
      // Launcher transitions rather than a launcher duplicate.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-runner-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const readyMarker = path.join(root, "child-ready.txt");
      // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds a path in fake child source.
      const encodedReadyMarker = JSON.stringify(readyMarker);
      const childSource =
        `const { writeFileSync } = require("node:fs");\n` +
        `writeFileSync(${encodedReadyMarker}, "ready");\n` +
        `setInterval(() => {}, 1_000);\n`;
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        childSource,
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        { runtimeInterpreter: process.execPath },
      );
      const running = launcher.run();
      // Wait for the interpreter-launched child to report readiness, bounded.
      yield* Effect.promise(async () => {
        for (let attempt = 0; attempt < 250; attempt += 1) {
          if (NodeFS.existsSync(readyMarker)) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      });
      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      yield* Effect.promise(() => running);

      // The interpreter-launched child actually started and was stopped by the
      // same production transition, not left behind.
      assert.isTrue(yield* fs.exists(readyMarker));
      assert.isTrue(yield* fs.exists(path.join(root, "runtime", SERVICE_STOP_MARKER_FILE)));
    }),
  );
});

it.layer(NodeServices.layer)("host control channel", (it) => {
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const controlPathOf = (path: Path.Path, root: string) =>
    path.join(root, "runtime", SERVICE_CONTROL_REQUEST_FILE);

  const stopRequest = (instance: string, requestId: string) =>
    JSON.stringify({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      type: "stop",
      instance,
      requestId,
    });

  const standUp = Effect.fn("test.stand_up_controlled_launcher")(function* (
    instance: string,
    childSource = "setInterval(() => {}, 1_000);\n",
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-launcher-control-" });
    const statePath = path.join(root, "runtime", "service-state.json");
    yield* writeFakeRuntime(fs, path, path.join(root, "runtime", "versions", "1.0.0"), childSource);
    yield* Effect.promise(() =>
      writeServiceState(statePath, {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.0.0",
      }),
    );
    const launcher = new Launcher(
      root,
      yield* Effect.promise(() => readServiceState(statePath)),
      yield* launcherOptions({ instance, pollIntervalMs: 20 }),
    );
    return {
      fs,
      root,
      launcher,
      controlPath: controlPathOf(path, root),
      stopMarkerPath: path.join(root, "runtime", SERVICE_STOP_MARKER_FILE),
    };
  });

  it.effect("delivers a host stop request to the production stop path", () =>
    Effect.gen(function* () {
      const { fs, launcher, controlPath, stopMarkerPath } = yield* standUp("instance-a");
      const running = launcher.run();
      yield* Effect.promise(() => delay(150));
      yield* fs.writeFileString(controlPath, stopRequest("instance-a", "req-1"));
      yield* Effect.promise(() => running);

      assert.isTrue(yield* fs.exists(stopMarkerPath));
      // The request is consumed before the stop runs, so it cannot fire twice.
      assert.isFalse(yield* fs.exists(controlPath));
    }),
  );

  it.effect("consumes a request written before the launcher starts (stop during startup)", () =>
    Effect.gen(function* () {
      const { fs, launcher, controlPath } = yield* standUp("instance-a");
      yield* fs.writeFileString(controlPath, stopRequest("instance-a", "req-1"));
      // No delay: the request is already present when run() begins.
      yield* Effect.promise(() => launcher.run());
      assert.isFalse(yield* fs.exists(controlPath));
    }),
  );

  it.effect("never acts on a stale request bound to another instance", () =>
    Effect.gen(function* () {
      const { fs, launcher, controlPath } = yield* standUp("instance-a");
      const running = launcher.run();
      yield* Effect.promise(() => delay(150));
      yield* fs.writeFileString(controlPath, stopRequest("instance-from-a-previous-run", "req-1"));

      let settled = false;
      void running.then(() => {
        settled = true;
      });
      yield* Effect.promise(() => delay(150));
      assert.isFalse(settled);
      // Consumed without effect, so it cannot linger for a later launcher.
      assert.isFalse(yield* fs.exists(controlPath));

      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      yield* Effect.promise(() => running);
    }),
  );

  it.effect("treats repeated stop requests and repeated stop calls as one shutdown", () =>
    Effect.gen(function* () {
      const { fs, launcher, controlPath } = yield* standUp("instance-a");
      const running = launcher.run();
      yield* Effect.promise(() => delay(150));
      yield* fs.writeFileString(controlPath, stopRequest("instance-a", "req-1"));
      yield* Effect.promise(() => delay(5));
      yield* fs.writeFileString(controlPath, stopRequest("instance-a", "req-2"));
      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      yield* Effect.promise(() => running);
    }),
  );
});
