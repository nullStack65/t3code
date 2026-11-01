import type { CodexSessionGuardSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

/**
 * Host-level admission gate for T3-owned Codex processes on an enrolled
 * Closura host.
 *
 * `enforce` is a refusal boundary, not a wrapper. The reviewed launcher holds
 * the delivery session fence for the provider's whole lifetime and hands it
 * over as one inherited descriptor, and the reviewed contract states that it
 * cannot prove a provider keeps that descriptor, closes it in descendants, or
 * avoids daemonizing. A T3-managed `codex app-server` has exactly that
 * unqualified shape, so launching one through the launcher would manufacture a
 * guarantee nobody can check. Refusing before any process or file side effect
 * is the only honest behaviour until the provider chain itself is qualified.
 *
 * `disabled` (the default) never inspects the filesystem, so hosts that never
 * opt in keep the existing spawn path byte for byte.
 */
export const CodexSessionGuardBlocker = Schema.Literals([
  /** The provider chain's fence-descriptor retention is not qualified. */
  "provider-descriptor-retention-unqualified",
  /** T3 would inject or inherit a provider-root override the guard rejects. */
  "provider-root-override",
  /** The fence contract only covers native macOS and Linux. */
  "platform-unqualified",
]);
export type CodexSessionGuardBlocker = typeof CodexSessionGuardBlocker.Type;

export const CodexSessionGuardRefusalReason = Schema.Literals([
  /** The configured references cannot identify one reviewed integration. */
  "invalid-settings",
  /** The references resolve, but this host/provider combination is unqualified. */
  "unqualified-host",
]);

export class CodexSessionGuardRefused extends Schema.TaggedError<CodexSessionGuardRefused>()(
  "CodexSessionGuardRefused",
  {
    reason: CodexSessionGuardRefusalReason,
    blockers: Schema.Array(CodexSessionGuardBlocker),
    /** Operator-facing diagnostic: field names and reasons, never values. */
    detail: Schema.String,
  },
) {
  override get message(): string {
    const suffix = this.blockers.length > 0 ? ` [${this.blockers.join(", ")}]` : "";
    return `Codex session guard refused the launch${suffix}: ${this.detail}`;
  }
}

export type CodexSessionGuardAdmission =
  | { readonly status: "disabled" }
  | { readonly status: "refused"; readonly refused: CodexSessionGuardRefused };

/**
 * Fail-closed policy for a settings document whose guard block cannot be
 * decoded. Construction refuses because no reference can validate, instead of
 * falling back to an unguarded launch that nobody enrolled for.
 */
export const codexSessionGuardRefusalPolicy: CodexSessionGuardSettings = {
  mode: "enforce",
  interpreter: "",
  launcher: "",
  sourceRoot: "",
  deviceFile: "",
  stateRoot: "",
};

/** Provider roots the reviewed guard refuses to run with an override for. */
const PROVIDER_ROOT_OVERRIDES = ["CODEX_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"] as const;

const RETENTION_DETAIL =
  "the reviewed fenced launcher requires a provider that keeps the inherited session fence " +
  "descriptor until it exits, which this build cannot qualify or enforce for a T3-managed Codex " +
  "process; enable Codex again only after that provider chain is qualified " +
  "(docs/internals/codex-session-guard.md)";

/** Device files are tiny JSON documents; refuse to read anything else. */
const MAX_DEVICE_FILE_BYTES = 1024n * 1024n;

/** Device documents are parsed as opaque JSON; only `state_root` is read. */
const decodeDeviceDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const invalidSettings = (field: string, detail: string) =>
  new CodexSessionGuardRefused({
    reason: "invalid-settings",
    blockers: [],
    detail: `${field} ${detail}`,
  });

const checkReferenceShape = Effect.fnUntraced(function* (
  field: string,
  value: string,
): Effect.fn.Return<void, CodexSessionGuardRefused, Path.Path> {
  const path = yield* Path.Path;
  if (value.trim().length === 0) return yield* invalidSettings(field, "is required");
  if (value.includes("\0")) return yield* invalidSettings(field, "must not contain NUL");
  if (!path.isAbsolute(value)) return yield* invalidSettings(field, "must be an absolute path");
});

/**
 * Canonical identity for an operator-supplied path. `realpath` must be
 * unchanged so two spellings of one target cannot look like two integrations,
 * and a symlinked reference is reported instead of silently followed.
 */
const canonicalEntry = Effect.fnUntraced(function* (
  field: string,
  value: string,
  expected: "File" | "Directory",
): Effect.fn.Return<
  FileSystem.File.Info,
  CodexSessionGuardRefused,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  yield* checkReferenceShape(field, value);
  const real = yield* fs
    .realPath(value)
    .pipe(Effect.orElseSucceed((): string | undefined => undefined));
  if (real === undefined) return yield* invalidSettings(field, "does not resolve on this host");
  if (real !== value) {
    return yield* invalidSettings(field, "must be a canonical path, not a symlink or alias");
  }
  const info = yield* fs
    .stat(value)
    .pipe(Effect.orElseSucceed((): FileSystem.File.Info | undefined => undefined));
  if (info === undefined) return yield* invalidSettings(field, "must exist");
  if (info.type !== expected) {
    return yield* invalidSettings(
      field,
      expected === "File" ? "must be a regular file" : "must be a directory",
    );
  }
  return info;
});

const validateReferences = Effect.fnUntraced(function* (
  settings: CodexSessionGuardSettings,
): Effect.fn.Return<void, CodexSessionGuardRefused, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  // A reviewed interpreter is commonly a package-manager symlink, so follow it
  // and require the target to be an executable regular file.
  yield* checkReferenceShape("interpreter", settings.interpreter);
  const interpreter = yield* fs
    .realPath(settings.interpreter)
    .pipe(Effect.orElseSucceed((): string | undefined => undefined));
  if (interpreter === undefined) return yield* invalidSettings("interpreter", "does not resolve");
  const interpreterInfo = yield* fs
    .stat(interpreter)
    .pipe(Effect.orElseSucceed((): FileSystem.File.Info | undefined => undefined));
  if (interpreterInfo === undefined || interpreterInfo.type !== "File") {
    return yield* invalidSettings("interpreter", "must be a regular file");
  }
  if ((Number(interpreterInfo.mode) & 0o111) === 0) {
    return yield* invalidSettings("interpreter", "must be executable");
  }

  yield* canonicalEntry("launcher", settings.launcher, "File");
  yield* canonicalEntry("sourceRoot", settings.sourceRoot, "Directory");
  // Bind the pair the same way the reviewed entrypoint does: the launcher must
  // be exactly this checkout's reviewed path. Depth and basename alone would
  // accept a same-shaped path under a different directory tree.
  const expectedLauncher = path.join(
    settings.sourceRoot,
    "company",
    "agent-environment",
    "config-delivery",
    "launch_provider.py",
  );
  if (expectedLauncher !== settings.launcher) {
    return yield* invalidSettings("launcher", "is not the reviewed path inside sourceRoot");
  }

  const deviceInfo = yield* canonicalEntry("deviceFile", settings.deviceFile, "File");
  if (BigInt(deviceInfo.size) > MAX_DEVICE_FILE_BYTES) {
    return yield* invalidSettings("deviceFile", "is too large to be a device document");
  }

  yield* canonicalEntry("stateRoot", settings.stateRoot, "Directory");
  const fenceRoot = path.join(settings.stateRoot, "session-fence");
  const fenceInfo = yield* canonicalEntry(
    "session fence",
    path.join(fenceRoot, ".omp-company-profile.lock"),
    "File",
  );
  // The reviewed runtime requires one stable, singly-linked inode: a hardlink
  // or symlink would make the shared lock cover a different object.
  if (Option.isNone(fenceInfo.nlink) || Number(fenceInfo.nlink.value) !== 1) {
    return yield* invalidSettings("session fence", "must be a single-link inode");
  }

  const raw = yield* fs
    .readFileString(settings.deviceFile)
    .pipe(Effect.orElseSucceed((): string | undefined => undefined));
  if (raw === undefined) return yield* invalidSettings("deviceFile", "cannot be read");
  const parsed = yield* decodeDeviceDocument(raw).pipe(
    Effect.orElseSucceed((): undefined => undefined),
  );
  if (
    parsed === undefined ||
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return yield* invalidSettings("deviceFile", "must contain a JSON object");
  }
  const declared = (parsed as { readonly state_root?: unknown }).state_root;
  if (typeof declared !== "string") {
    return yield* invalidSettings("deviceFile", "must declare a state_root");
  }
  // Bind the guard to the state root the device itself declares, so a stale or
  // crossed device file cannot enroll the wrong fence.
  yield* canonicalEntry("device state_root", declared, "Directory");
  if (declared !== settings.stateRoot) {
    return yield* invalidSettings("stateRoot", "does not match the device state_root");
  }
});

/**
 * Decide whether a T3-owned Codex process may start on this host.
 *
 * The returned admission is a decision only: callers refuse before spawning.
 * `homePath` is the `CODEX_HOME` T3 would inject for the instance (`""` when it
 * injects none) and `environment` is the merged provider environment, because
 * an inherited override reaches Codex just as effectively as an injected one.
 */
export const admitCodexSession = Effect.fn("admitCodexSession")(function* (input: {
  readonly settings: CodexSessionGuardSettings;
  readonly homePath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform?: string | undefined;
}): Effect.fn.Return<CodexSessionGuardAdmission, never, FileSystem.FileSystem | Path.Path> {
  if (input.settings.mode !== "enforce") return { status: "disabled" } as const;

  const references = yield* Effect.result(validateReferences(input.settings));
  if (references._tag === "Failure") {
    return { status: "refused", refused: references.failure } as const;
  }

  const platform = input.platform ?? (yield* HostProcessPlatform);
  const blockers: Array<CodexSessionGuardBlocker> = [];
  if (platform !== "darwin" && platform !== "linux") blockers.push("platform-unqualified");
  const overrides = [
    ...(input.homePath.trim().length > 0 ? ["CODEX_HOME"] : []),
    ...PROVIDER_ROOT_OVERRIDES.filter((name) => (input.environment[name] ?? "").length > 0),
  ];
  if (overrides.length > 0) blockers.push("provider-root-override");
  // Retention is decided by the provider chain, not by anything T3 can read, so
  // there is no reference set that can clear this blocker.
  blockers.push("provider-descriptor-retention-unqualified");

  return {
    status: "refused",
    refused: new CodexSessionGuardRefused({
      reason: "unqualified-host",
      blockers,
      detail:
        overrides.length > 0
          ? `${RETENTION_DETAIL}; the reviewed guard also refuses provider-root overrides, and this host would pass ${overrides.join(", ")}`
          : RETENTION_DETAIL,
    }),
  } as const;
});
