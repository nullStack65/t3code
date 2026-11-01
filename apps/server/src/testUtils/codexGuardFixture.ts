import type { CodexSessionGuardSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";

const DeviceDocument = Schema.Struct({ device: Schema.String, state_root: Schema.String });
const encodeDeviceDocument = Schema.encodeSync(Schema.fromJsonString(DeviceDocument));

export interface CodexGuardFixture {
  readonly sourceRoot: string;
  readonly launcher: string;
  readonly interpreter: string;
  readonly deviceFile: string;
  readonly stateRoot: string;
  readonly fence: string;
  readonly settings: CodexSessionGuardSettings;
}

/**
 * A disposable reviewed-integration layout: a checkout holding the reviewed
 * entrypoint at its documented path, a python interpreter, and a delivery state
 * root with an initialized session fence plus the device document naming it.
 *
 * Paths are canonical because the reviewed launcher compares its checkout root
 * to the running library root; on macOS `/var` is a symlink, so the temporary
 * directory is resolved first.
 */
export const makeCodexGuardFixture = Effect.fnUntraced(function* (): Effect.fn.Return<
  CodexGuardFixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-session-guard-" });
  const sourceRoot = yield* fs.realPath(tempDirectory);

  const launcher = path.join(
    sourceRoot,
    "company",
    "agent-environment",
    "config-delivery",
    "launch_provider.py",
  );
  yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
  yield* fs.writeFileString(launcher, "# reviewed launcher\n");

  const interpreter = path.join(sourceRoot, "bin", "python3");
  yield* fs.makeDirectory(path.dirname(interpreter), { recursive: true });
  yield* fs.writeFileString(interpreter, "#!/bin/sh\n");
  yield* fs.chmod(interpreter, 0o755);

  const stateRoot = path.join(sourceRoot, "state");
  const fence = path.join(stateRoot, "session-fence", ".omp-company-profile.lock");
  yield* fs.makeDirectory(path.dirname(fence), { recursive: true });
  yield* fs.writeFileString(fence, "");

  const deviceFile = path.join(sourceRoot, "device.json");
  yield* fs.writeFileString(
    deviceFile,
    encodeDeviceDocument({ device: "mac-fixture", state_root: stateRoot }),
  );

  return {
    sourceRoot,
    launcher,
    interpreter,
    deviceFile,
    stateRoot,
    fence,
    settings: {
      mode: "enforce" as const,
      interpreter,
      launcher,
      sourceRoot,
      deviceFile,
      stateRoot,
    },
  } satisfies CodexGuardFixture;
});

/** Rewrite the device document, e.g. to name a state root the guard must reject. */
export const writeDeviceDocument = (deviceFile: string, stateRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      deviceFile,
      encodeDeviceDocument({ device: "mac-fixture", state_root: stateRoot }),
    );
  });
