import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  CLOSURA_FORK_USER_DATA_DIR,
  clearStaleGpuCaches,
  resolveUserDataPath,
} from "./DesktopUserData.ts";

it.effect.each(["linux", "darwin", "win32"] as const)(
  "uses a distinct Closura fork user-data directory on %s and migrates existing t3code-v2 state once (CLO-1100)",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-closura-profile-" });
      const stockDir = path.join(directory, "t3code-v2");
      const forkDir = path.join(directory, CLOSURA_FORK_USER_DATA_DIR);

      yield* fs.makeDirectory(path.join(stockDir, "Local Storage"), { recursive: true });
      yield* fs.makeDirectory(path.join(stockDir, "GPUCache"), { recursive: true });
      yield* fs.writeFileString(path.join(stockDir, "Preferences"), '{"fork":true}');
      yield* fs.writeFileString(path.join(stockDir, "Local Storage", "data"), "saved-state");
      yield* fs.writeFileString(path.join(stockDir, "Local Storage", "LOCK"), "locked");
      yield* fs.writeFileString(path.join(stockDir, "SingletonLock"), "pid");
      yield* fs.writeFileString(path.join(stockDir, "GPUCache", "data_0"), "stale-gpu");

      const firstPath = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform,
      });
      assert.equal(firstPath, forkDir);
      assert.notEqual(firstPath, stockDir);
      assert.equal(yield* fs.readFileString(path.join(forkDir, "Preferences")), '{"fork":true}');
      assert.equal(
        yield* fs.readFileString(path.join(forkDir, "Local Storage", "data")),
        "saved-state",
      );
      assert.isFalse(yield* fs.exists(path.join(forkDir, "SingletonLock")));
      assert.isFalse(yield* fs.exists(path.join(forkDir, "Local Storage", "LOCK")));
      assert.isFalse(yield* fs.exists(path.join(forkDir, "GPUCache")));
      assert.isTrue(yield* fs.exists(path.join(forkDir, ".migrated-from-t3code-v2")));
      // Stock profile remains intact for side-by-side stock T3 Code installs.
      assert.equal(yield* fs.readFileString(path.join(stockDir, "Preferences")), '{"fork":true}');

      // Subsequent launches must not overwrite fork state even if stock profile changes.
      yield* fs.writeFileString(path.join(forkDir, "Preferences"), '{"fork":"updated"}');
      yield* fs.writeFileString(path.join(stockDir, "Preferences"), '{"stock":"mutated"}');
      const secondPath = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform,
      });
      assert.equal(secondPath, forkDir);
      assert.equal(
        yield* fs.readFileString(path.join(forkDir, "Preferences")),
        '{"fork":"updated"}',
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "redoes an interrupted t3code-v2 migration instead of keeping a partial fork profile (CLO-1100)",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-closura-partial-" });
      const stockDir = path.join(directory, "t3code-v2");
      const forkDir = path.join(directory, CLOSURA_FORK_USER_DATA_DIR);
      const stagingDir = `${forkDir}.migrating`;
      yield* fs.makeDirectory(path.join(stockDir, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(stockDir, "Preferences"), "prefs");
      yield* fs.writeFileString(path.join(stockDir, "IndexedDB", "db"), "indexed");
      yield* fs.writeFileString(path.join(stockDir, "Cookies"), "cookies");

      // A copy that failed partway leaves only its staging directory behind.
      yield* fs.makeDirectory(stagingDir, { recursive: true });
      yield* fs.writeFileString(path.join(stagingDir, "Preferences"), "prefs");
      const cookies = path.join(stockDir, "Cookies");
      yield* fs.chmod(cookies, 0o000);
      const failure = yield* Effect.flip(
        resolveUserDataPath({
          appDataDirectory: directory,
          isDevelopment: false,
          platform: "linux",
        }),
      );
      assert.equal(failure._tag, "DesktopUserDataInitializationError");
      assert.isFalse(yield* fs.exists(forkDir));

      yield* fs.chmod(cookies, 0o644);
      const resolved = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "linux",
      });
      assert.equal(resolved, forkDir);
      assert.isFalse(yield* fs.exists(stagingDir));
      assert.equal(yield* fs.readFileString(path.join(forkDir, "IndexedDB", "db")), "indexed");
      assert.equal(yield* fs.readFileString(path.join(forkDir, "Cookies")), "cookies");
      assert.isTrue(yield* fs.exists(path.join(forkDir, ".migrated-from-t3code-v2")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["t3code", "T3 Code (Alpha)"])(
  "preserves Windows credential keys from %s without copying browser databases",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
      const source = path.join(directory, sourceName);
      const destination = path.join(directory, CLOSURA_FORK_USER_DATA_DIR);
      const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
      yield* fs.makeDirectory(path.join(directory, "T3 Code (Alpha)"), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), state);
      yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
      assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
      assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
      yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(
        yield* fs.readFileString(path.join(destination, "Local State")),
        "existing V2 state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const gpuCacheDirectories = [
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUPersistentCache",
];

it.effect.each([
  { profile: "written by Electron 44.10.0", marker: "44.10.0" },
  { profile: "with no recorded Electron version", marker: undefined },
])("clears GPU caches $profile once when Electron 44.10.1 starts", ({ marker }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const userDataPath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-gpu-cache-" });
    for (const name of gpuCacheDirectories) {
      yield* fs.makeDirectory(path.join(userDataPath, name), { recursive: true });
      yield* fs.writeFileString(path.join(userDataPath, name, "data_0"), "44.10.0 shaders");
    }
    yield* fs.makeDirectory(path.join(userDataPath, "Local Storage"), { recursive: true });
    yield* fs.writeFileString(path.join(userDataPath, "Local Storage", "LOCK"), "profile");
    yield* fs.writeFileString(path.join(userDataPath, "Local State"), "profile");
    if (marker !== undefined) {
      yield* fs.writeFileString(path.join(userDataPath, "gpu-cache-electron-version"), marker);
    }

    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.10.1" });

    const survivingCaches: Array<string> = [];
    for (const name of gpuCacheDirectories) {
      if (yield* fs.exists(path.join(userDataPath, name))) survivingCaches.push(name);
    }
    assert.deepStrictEqual(survivingCaches, []);
    assert.equal(
      yield* fs.readFileString(path.join(userDataPath, "Local Storage", "LOCK")),
      "profile",
    );
    assert.equal(yield* fs.readFileString(path.join(userDataPath, "Local State")), "profile");

    yield* fs.makeDirectory(path.join(userDataPath, "GPUCache"));
    yield* fs.writeFileString(path.join(userDataPath, "GPUCache", "data_0"), "44.10.1 shaders");
    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.10.1" });
    assert.equal(
      yield* fs.readFileString(path.join(userDataPath, "GPUCache", "data_0")),
      "44.10.1 shaders",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps GPU caches built on the first launch of a fresh install", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const appData = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-fresh-" });
    const userDataPath = path.join(appData, "t3code-v2");

    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.10.1" });
    yield* fs.makeDirectory(path.join(userDataPath, "GPUCache"));
    yield* fs.writeFileString(path.join(userDataPath, "GPUCache", "data_0"), "44.10.1 shaders");
    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.10.1" });

    assert.equal(
      yield* fs.readFileString(path.join(userDataPath, "GPUCache", "data_0")),
      "44.10.1 shaders",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("retries on the next launch when a GPU cache cannot be removed", () =>
  Effect.gen(function* () {
    const writes: Array<string> = [];
    const fileSystem = FileSystem.makeNoop({
      remove: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: path,
          }),
        ),
      writeFileString: (path) =>
        Effect.sync(() => {
          writes.push(path);
        }),
    });

    yield* clearStaleGpuCaches({ userDataPath: "/profile", electronVersion: "44.10.1" }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );

    assert.deepStrictEqual(writes, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
