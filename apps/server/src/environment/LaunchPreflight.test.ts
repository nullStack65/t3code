// @effect-diagnostics nodeBuiltinImport:off - real temp directories exercise the bounded probes.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { CheckpointRef } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { writeFakeCli } from "../testUtils/fakeCli.ts";
import * as LaunchPreflight from "./LaunchPreflight.ts";

const isWindows = process.platform === "win32";

/** Resolves the real Git executable the same way on every host. */
const resolveRealGitPath = (): string => {
  const finder = isWindows ? "where.exe" : "which";
  const output = NodeChildProcess.execFileSync(finder, ["git"], { encoding: "utf8" });
  const first = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (first === undefined) throw new Error("git was not found on PATH");
  return first;
};

/**
 * Writes a portable executable named `git` into `binDir`. The behavior lives in
 * a Node stub (launched by a `.cmd` shim on Windows, a `sh` launcher elsewhere)
 * so the fixture runs natively on every host and the real resolver/launcher is
 * exercised. `body` is module source with `process.argv.slice(2)` as Git's args;
 * `__REAL_GIT__` is replaced with the real Git path.
 */
const writeGitStub = (binDir: string, body: string, realGit: string): string => {
  NodeFS.mkdirSync(binDir, { recursive: true });
  return writeFakeCli({
    directory: binDir,
    name: "git",
    source: body.replaceAll("__REAL_GIT__", JSON.stringify(realGit)),
    platform: process.platform,
  });
};

const probeError = (
  reason: LaunchPreflight.LaunchPreflightProbeFailureReason,
  detail = "probe failed",
) => new LaunchPreflight.LaunchPreflightProbeError({ reason, detail });

const identity = (
  overrides: Partial<LaunchPreflight.LaunchPreflightRepoIdentity> = {},
): LaunchPreflight.LaunchPreflightRepoIdentity => ({
  state: "not-a-repository",
  topLevel: null,
  commonDir: null,
  detail: "",
  ...overrides,
});

const gitProbe = (
  overrides: Partial<LaunchPreflight.LaunchPreflightGitProbe> = {},
): LaunchPreflight.LaunchPreflightGitProbe => ({
  version: () => Effect.succeed("2.55.0"),
  resolveIdentity: () => Effect.succeed(identity()),
  isSparseCheckout: () => Effect.succeed(false),
  probeSparseAdd: () => Effect.succeed("supported"),
  ...overrides,
});

const input = (options: {
  readonly root?: string;
  readonly isSharedRoot?: boolean;
  readonly configuredRoot?: string;
  readonly git?: LaunchPreflight.LaunchPreflightGitProbe;
  readonly files?: Partial<LaunchPreflight.LaunchPreflightFileProbe>;
  readonly consumer?: LaunchPreflight.LaunchPreflightConsumer;
  readonly gitEnvironment?: NodeJS.ProcessEnv;
}): LaunchPreflight.LaunchPreflightInput => ({
  root: options.root ?? "/session-root",
  ...(options.isSharedRoot !== undefined ? { isSharedRoot: options.isSharedRoot } : {}),
  ...(options.configuredRoot !== undefined ? { configuredRoot: options.configuredRoot } : {}),
  ...(options.consumer !== undefined ? { consumer: options.consumer } : {}),
  ...(options.gitEnvironment !== undefined ? { gitEnvironment: options.gitEnvironment } : {}),
  git: options.git ?? gitProbe(),
  files: {
    exists: () => Effect.succeed(false),
    stat: () => Effect.succeed({ type: "directory" }),
    realPath: (target) => Effect.succeed(target),
    readFirstBytes: () => Effect.succeed(16),
    ...options.files,
  },
});

const codes = (result: LaunchPreflight.LaunchPreflightResult) =>
  result.findings.map((finding) => finding.code);

const severities = (result: LaunchPreflight.LaunchPreflightResult) =>
  result.findings.map((finding) => finding.severity);

const run = (probeInput: LaunchPreflight.LaunchPreflightInput) =>
  LaunchPreflight.runLaunchPreflight(probeInput).pipe(Effect.provide(NodeServices.layer));

it.effect("passes an ordinary repository session with a supported Git", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/repo",
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(identity({ state: "ok", topLevel: "/repo", commonDir: "/repo/.git" })),
        }),
        files: {
          exists: (target) =>
            Effect.succeed(target === "/repo/.git" || target.endsWith("package.json")),
        },
      }),
    );

    assert.deepStrictEqual(result.findings, []);
  }),
);

it.effect("passes a non-Git shared session root", () =>
  Effect.gen(function* () {
    const result = yield* run(input({ isSharedRoot: true }));

    assert.deepStrictEqual(result.findings, []);
  }),
);

it.effect("does not count a retired Git marker as a repository by its name alone", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/Documents",
        isSharedRoot: true,
        git: gitProbe({
          resolveIdentity: () => Effect.succeed(identity()),
        }),
        files: {
          exists: (target) => Effect.succeed(target === "/Documents/.git.macfix-m1-retired"),
        },
      }),
    );

    assert.deepStrictEqual(result.findings, []);
  }),
);

it.effect("flags an accidental umbrella repository at the shared root", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/Documents",
        isSharedRoot: true,
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(
              identity({ state: "ok", topLevel: "/Documents", commonDir: "/Documents/.git" }),
            ),
        }),
        files: { exists: (target) => Effect.succeed(target === "/Documents/.git") },
      }),
    );

    assert.deepStrictEqual(codes(result), ["shared-root-git"]);
    assert.deepStrictEqual(severities(result), ["warning"]);
    assert.include(result.warnings[0]?.message ?? "", NodePath.join("/Documents", ".git"));
  }),
);

it.effect("does not require child enumeration to detect the umbrella", () =>
  Effect.gen(function* () {
    // No directory listing is part of the probe interface at all: detection is
    // exact normalized root identity, so it cannot depend on child breadth.
    const result = yield* run(
      input({
        root: "/Documents",
        isSharedRoot: true,
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(
              identity({ state: "ok", topLevel: "/Documents", commonDir: "/Documents/.git" }),
            ),
        }),
        files: { exists: (target) => Effect.succeed(target === "/Documents/.git") },
      }),
    );

    assert.deepStrictEqual(codes(result), ["shared-root-git"]);
  }),
);

it.effect("does not flag an ordinary repository root that is not a shared root", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/repo",
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(identity({ state: "ok", topLevel: "/repo", commonDir: "/repo/.git" })),
        }),
        files: { exists: (target) => Effect.succeed(target === "/repo/.git") },
      }),
    );

    assert.deepStrictEqual(result.findings, []);
  }),
);

it.effect("does not flag a nested repository selected as the session cwd", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/Documents/project",
        isSharedRoot: false,
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(
              identity({
                state: "ok",
                topLevel: "/Documents/project",
                commonDir: "/Documents/project/.git",
              }),
            ),
        }),
        files: { exists: (target) => Effect.succeed(target === "/Documents/project/.git") },
      }),
    );

    assert.deepStrictEqual(result.findings, []);
  }),
);

it.effect("does not advise retiring the root .git when identity points elsewhere", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/Documents",
        isSharedRoot: true,
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(
              identity({ state: "ok", topLevel: "/Documents", commonDir: "/elsewhere/.git" }),
            ),
        }),
        files: { exists: (target) => Effect.succeed(target === "/Documents/.git") },
      }),
    );

    const message = result.warnings[0]?.message ?? "";
    assert.include(message, "points at a different repository");
    assert.notInclude(message, "Move or retire /Documents/.git");
  }),
);

it.effect("warns (does not block) when Git cannot start under a non-repository root", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({ git: { ...gitProbe(), version: () => Effect.fail(probeError("unavailable")) } }),
    );

    assert.deepStrictEqual(codes(result), ["git-startup-failed"]);
    assert.deepStrictEqual(severities(result), ["warning"]);
  }),
);

it.effect("blocks when Git cannot start and the session root is a repository", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/repo",
        git: { ...gitProbe(), version: () => Effect.fail(probeError("unavailable")) },
        files: { exists: (target) => Effect.succeed(target === NodePath.join("/repo", ".git")) },
      }),
    );

    assert.deepStrictEqual(severities(result), ["blocker"]);
    assert.include(result.blockers[0]?.message ?? "", "could not be started");
  }),
);

it.effect("never blocks or warns about the harmless missing --path-format fast path", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/repo",
        isSharedRoot: false,
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(identity({ state: "ok", topLevel: "/repo", commonDir: "/repo/.git" })),
        }),
        files: { exists: (target) => Effect.succeed(target === "/repo/.git") },
      }),
    );

    assert.deepStrictEqual(result.blockers, []);
    assert.deepStrictEqual(result.findings, []);
  }),
);

it.effect("warns when a sparse checkout's resolved Git lacks git add --sparse", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/repo",
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(identity({ state: "ok", topLevel: "/repo", commonDir: "/repo/.git" })),
          probeSparseAdd: () => Effect.succeed("unsupported"),
          isSparseCheckout: () => Effect.succeed(true),
        }),
        files: { exists: (target) => Effect.succeed(target === "/repo/.git") },
      }),
    );

    assert.deepStrictEqual(codes(result), ["git-sparse-add-unsupported"]);
    assert.deepStrictEqual(severities(result), ["warning"]);
    assert.include(result.warnings[0]?.message ?? "", "--sparse");
  }),
);

it.effect("does not warn about git add --sparse when the repository is not sparse", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/repo",
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(identity({ state: "ok", topLevel: "/repo", commonDir: "/repo/.git" })),
          isSparseCheckout: () => Effect.succeed(false),
        }),
        files: { exists: (target) => Effect.succeed(target === "/repo/.git") },
      }),
    );

    assert.deepStrictEqual(result.findings, []);
  }),
);

it.effect("flags a Git probe that reports a timeout", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({ git: { ...gitProbe(), version: () => Effect.fail(probeError("timeout")) } }),
    );

    assert.deepStrictEqual(codes(result), ["git-probe-timed-out"]);
    assert.deepStrictEqual(severities(result), ["warning"]);
  }),
);

it.effect("bounds a hung Git probe instead of holding the launch", () =>
  Effect.gen(function* () {
    const fiber = yield* run(input({ git: { ...gitProbe(), version: () => Effect.never } })).pipe(
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1500 millis");
    const result = yield* Fiber.join(fiber);

    assert.deepStrictEqual(codes(result), ["git-probe-timed-out"]);
  }),
);

it.effect("flags a slow root read and bounds it instead of holding the launch", () =>
  Effect.gen(function* () {
    const fiber = yield* run(
      input({
        files: {
          exists: (target) => Effect.succeed(target.endsWith("package.json")),
          readFirstBytes: () => Effect.never,
        },
      }),
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("500 millis");
    const result = yield* Fiber.join(fiber);

    assert.deepStrictEqual(codes(result), ["root-read-slow"]);
  }),
);

it.effect("reports an incomplete preflight instead of clean when checks hang", () =>
  Effect.gen(function* () {
    const fiber = yield* run(
      input({
        files: {
          exists: () => Effect.never,
          readFirstBytes: () => Effect.never,
        },
      }),
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("5 seconds");
    const result = yield* Fiber.join(fiber);

    // A hung metadata/existence check is not absence: the preflight is not
    // clean, it returns its bounded findings, and it still completes.
    assert.isTrue(result.findings.length > 0);
    assert.isTrue(result.findings.every((finding) => finding.severity === "warning"));
    assert.isTrue(codes(result).includes("root-read-slow"));
  }),
);

// --- R1 regression: incomplete checks warn, genuine absence stays quiet ------

it.effect("R1: a hung initial cwd stat warns and returns within its budget", () =>
  Effect.gen(function* () {
    const fiber = yield* run(input({ files: { stat: () => Effect.never } })).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("500 millis");
    const result = yield* Fiber.join(fiber);

    assert.deepStrictEqual(codes(result), ["root-read-slow"]);
    assert.deepStrictEqual(severities(result), ["warning"]);
    assert.include(result.warnings[0]?.message ?? "", "did not finish in time");
  }),
);

it.effect("R1: a failed initial cwd stat warns instead of silently skipping", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({ files: { stat: () => Effect.fail(probeError("failed", "denied")) } }),
    );

    assert.deepStrictEqual(codes(result), ["root-read-failed"]);
    assert.deepStrictEqual(severities(result), ["warning"]);
  }),
);

it.effect("R1: a hung candidate metadata check warns instead of reading as absent", () =>
  Effect.gen(function* () {
    const fiber = yield* run(input({ files: { exists: () => Effect.never } })).pipe(
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1500 millis");
    const result = yield* Fiber.join(fiber);

    assert.isTrue(codes(result).includes("root-read-slow"));
    assert.isTrue(result.findings.length > 0);
  }),
);

it.effect(
  "R1: a required capability probe that hangs after healthy identity warns as incomplete",
  () =>
    Effect.gen(function* () {
      const fiber = yield* run(
        input({
          root: "/repo",
          git: gitProbe({
            resolveIdentity: () =>
              Effect.succeed(identity({ state: "ok", topLevel: "/repo", commonDir: "/repo/.git" })),
            probeSparseAdd: () => Effect.never,
          }),
          consumer: { driver: "opencode", snapshotsEnabled: true },
          files: { exists: (target) => Effect.succeed(target === "/repo/.git") },
        }),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1500 millis");
      const result = yield* Fiber.join(fiber);

      assert.deepStrictEqual(codes(result), ["git-probe-timed-out"]);
    }),
);

it.effect("R1: a required capability probe failure warns as incomplete, never unsupported", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/repo",
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(identity({ state: "ok", topLevel: "/repo", commonDir: "/repo/.git" })),
          probeSparseAdd: () => Effect.fail(probeError("failed")),
        }),
        consumer: { driver: "opencode", snapshotsEnabled: true },
        files: { exists: (target) => Effect.succeed(target === "/repo/.git") },
      }),
    );

    assert.deepStrictEqual(codes(result), ["git-probe-failed"]);
    assert.notInclude(codes(result), "git-sparse-add-unsupported");
  }),
);

it.effect("R1: genuinely absent optional files stay quiet", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/repo",
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(identity({ state: "ok", topLevel: "/repo", commonDir: "/repo/.git" })),
        }),
        files: { exists: (target) => Effect.succeed(target === "/repo/.git") },
      }),
    );

    assert.deepStrictEqual(result.findings, []);
  }),
);

// --- R2 regression: equivalent physical paths share identity handling --------

it.effect("R2: alias spellings of the same physical root give local-metadata guidance", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/var/folders/x/shared",
        isSharedRoot: true,
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(
              identity({
                state: "ok",
                topLevel: "/private/var/folders/x/shared",
                commonDir: "/var/folders/x/shared/.git",
              }),
            ),
        }),
        files: {
          exists: (target) => Effect.succeed(target.endsWith(".git")),
          realPath: (target) =>
            Effect.succeed(target.startsWith("/var/") ? `/private${target}` : target),
        },
      }),
    );

    assert.deepStrictEqual(codes(result), ["shared-root-git"]);
    const message = result.warnings[0]?.message ?? "";
    assert.include(message, "Move or retire");
    assert.notInclude(message, "different repository");
  }),
);

it.effect("R2: failed canonicalization does not assert an external repository", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/Documents",
        isSharedRoot: true,
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(
              identity({ state: "ok", topLevel: "/Documents", commonDir: "/Documents/.git" }),
            ),
        }),
        files: {
          exists: (target) => Effect.succeed(target === "/Documents/.git"),
          realPath: () => Effect.succeed(null),
        },
      }),
    );

    assert.deepStrictEqual(codes(result), ["shared-root-git"]);
    const message = result.warnings[0]?.message ?? "";
    assert.notInclude(message, "different repository");
    assert.notInclude(message, "Move or retire");
    assert.include(message, "could not be fully resolved");
  }),
);

// --- W1-A: the production file probe preserves metadata failures --------------

it.effect("W1-A: genuine absence is quiet but a denied metadata read is a probe failure", () =>
  Effect.gen(function* () {
    const real = yield* FileSystem.FileSystem;
    const probe = LaunchPreflight.makeFileProbe(real);
    // Genuine absence stays `false` (quiet), never a warning.
    assert.strictEqual(yield* probe.exists(NodePath.join(NodeOS.tmpdir(), "envchk-absent-x")), false);

    // A denied lookup is not absence: the production adapter must surface it as
    // a probe failure instead of converting it to `false`.
    const deniedLayer = Layer.mock(FileSystem.FileSystem)({
      stat: (target) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "stat",
            pathOrDescriptor: target,
          }),
        ),
    });
    const denied = yield* FileSystem.FileSystem.pipe(Effect.provide(deniedLayer));
    const deniedProbe = LaunchPreflight.makeFileProbe(denied);
    const error = yield* deniedProbe.exists("/denied/AGENTS.md").pipe(Effect.flip);
    assert.strictEqual(error.reason, "failed");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("W1-A: a denied candidate metadata read warns instead of reading as absent", () =>
  Effect.gen(function* () {
    const denied = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "stat",
      pathOrDescriptor: "candidate",
    });
    const result = yield* run(
      input({
        root: "/repo",
        files: {
          // Every metadata read is denied, including the initial cwd stat.
          exists: () => Effect.fail(probeError("failed", String(denied))),
          stat: () => Effect.fail(probeError("failed", String(denied))),
        },
      }),
    );

    assert.deepStrictEqual(codes(result), ["root-read-failed"]);
    assert.deepStrictEqual(severities(result), ["warning"]);
  }),
);

// --- W1-B: incomplete relevant capability checks warn for sparse checkouts ----

it.effect("W1-B: a failed capability probe for a verified sparse checkout warns (non-OpenCode)", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/repo",
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(identity({ state: "ok", topLevel: "/repo", commonDir: "/repo/.git" })),
          isSparseCheckout: () => Effect.succeed(true),
          probeSparseAdd: () => Effect.fail(probeError("failed", "denied")),
        }),
        files: { exists: (target) => Effect.succeed(target === "/repo/.git") },
      }),
    );

    // Applicability came from the verified sparse checkout, not the consumer.
    assert.deepStrictEqual(codes(result), ["git-probe-failed"]);
    assert.notInclude(codes(result), "git-sparse-add-unsupported");
  }),
);

it.effect("W1-B: a hung capability probe for a verified sparse checkout warns (non-OpenCode)", () =>
  Effect.gen(function* () {
    const fiber = yield* run(
      input({
        root: "/repo",
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(identity({ state: "ok", topLevel: "/repo", commonDir: "/repo/.git" })),
          isSparseCheckout: () => Effect.succeed(true),
          probeSparseAdd: () => Effect.never,
        }),
        files: { exists: (target) => Effect.succeed(target === "/repo/.git") },
      }),
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1500 millis");
    const result = yield* Fiber.join(fiber);

    assert.deepStrictEqual(codes(result), ["git-probe-timed-out"]);
  }),
);

it.effect("W1-B: a non-required repository with an incomplete capability check stays quiet", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/repo",
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(identity({ state: "ok", topLevel: "/repo", commonDir: "/repo/.git" })),
          isSparseCheckout: () => Effect.succeed(false),
          probeSparseAdd: () => Effect.never,
        }),
        files: { exists: (target) => Effect.succeed(target === "/repo/.git") },
      }),
    );

    assert.deepStrictEqual(result.findings, []);
  }),
);

// --- W1-C: canonical configured-root identity through both directions ---------

it.effect("W1-C: alias spellings of the configured root still recognize shared intent", () =>
  Effect.gen(function* () {
    // The configured root and the actual cwd are the same physical directory
    // under different spellings; only the canonical compare can see that.
    const result = yield* run(
      input({
        root: "/private/var/folders/x/shared",
        configuredRoot: "/var/folders/x/shared",
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(
              identity({
                state: "ok",
                topLevel: "/private/var/folders/x/shared",
                commonDir: "/private/var/folders/x/shared/.git",
              }),
            ),
        }),
        files: {
          exists: (target) => Effect.succeed(target.endsWith(".git")),
          realPath: (target) =>
            Effect.succeed(target.startsWith("/var/") ? `/private${target}` : target),
        },
      }),
    );

    assert.deepStrictEqual(codes(result), ["shared-root-git"]);
  }),
);

it.effect("W1-C: a genuinely different configured root stays ordinary", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/repo",
        configuredRoot: "/elsewhere",
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(identity({ state: "ok", topLevel: "/repo", commonDir: "/repo/.git" })),
        }),
        files: { exists: (target) => Effect.succeed(target === "/repo/.git") },
      }),
    );

    assert.deepStrictEqual(result.findings, []);
  }),
);

it.effect("W1-C: a nested repository selected as cwd stays ordinary under a configured root", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/Documents/project",
        configuredRoot: "/Documents",
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(
              identity({
                state: "ok",
                topLevel: "/Documents/project",
                commonDir: "/Documents/project/.git",
              }),
            ),
        }),
        files: { exists: (target) => Effect.succeed(target === "/Documents/project/.git") },
      }),
    );

    assert.deepStrictEqual(result.findings, []);
  }),
);

it.effect("W1-C: an unresolved configured-root identity does not invent an umbrella", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/var/folders/x/shared",
        configuredRoot: "/private/var/folders/x/shared",
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(identity({ state: "ok", topLevel: "/var/folders/x/shared", commonDir: "/var/folders/x/shared/.git" })),
        }),
        files: {
          exists: (target) => Effect.succeed(target.endsWith(".git")),
          // Canonicalization is unavailable for both sides.
          realPath: () => Effect.succeed(null),
        },
      }),
    );

    assert.deepStrictEqual(result.findings, []);
  }),
);

it.effect("wires the real service probes and passes a healthy root", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-launch-preflight-")),
    );
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(directory, "package.json"), '{"name":"preflight"}\n'),
    );

    const layer = LaunchPreflight.layer.pipe(
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (processInput) =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: processInput.args.includes("--version")
                ? "git version 2.55.0\n"
                : processInput.args.includes("--show-toplevel")
                  ? `${directory}\n`
                  : processInput.args.includes("--git-common-dir")
                    ? `${NodePath.join(directory, ".git")}\n`
                    : `${NodePath.join(directory, ".git", "index")}\n`,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
      Layer.provide(NodeServices.layer),
    );

    const result = yield* LaunchPreflight.LaunchPreflight.pipe(
      Effect.flatMap((preflight) => preflight.run(directory)),
      Effect.provide(layer),
    );

    assert.deepStrictEqual(result.findings, []);
    yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  }),
);

it.effect("real Git probes flag a disposable umbrella repository and never write to it", () =>
  Effect.gen(function* () {
    const base = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-launch-preflight-real-")),
    );
    const umbrella = NodePath.join(base, "umbrella");
    const nested = NodePath.join(umbrella, "project");
    yield* Effect.promise(() => NodeFSP.mkdir(nested, { recursive: true }));
    NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: umbrella });
    NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: nested });
    const before = (yield* Effect.promise(() => NodeFSP.readdir(umbrella))).sort();

    const layer = LaunchPreflight.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(NodeServices.layer),
    );

    const result = yield* LaunchPreflight.LaunchPreflight.pipe(
      Effect.flatMap((preflight) => preflight.run(umbrella, { isSharedRoot: true })),
      Effect.provide(layer),
    );

    assert.include(codes(result), "shared-root-git");
    assert.deepStrictEqual((yield* Effect.promise(() => NodeFSP.readdir(umbrella))).sort(), before);
    yield* Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true }));
  }),
);

// --- R1 regression: a Git without `--path-format` still launches and checkpoints -----------------

const E3VcsLayer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));
const E3PreflightLayer = LaunchPreflight.layer.pipe(Layer.provide(E3VcsLayer));
const E3CombinedLayer = Layer.merge(E3VcsLayer, E3PreflightLayer);

/** A `git` that rejects `--path-format` (like Git < 2.31) and delegates everything else. */
const writePathFormatRejectingGit = (binDir: string, realGit: string) =>
  writeGitStub(
    binDir,
    [
      'import { spawnSync } from "node:child_process";',
      "const args = process.argv.slice(2);",
      "for (const a of args) {",
      '  if (a === "--path-format" || a.startsWith("--path-format=")) {',
      "    process.stderr.write(\"fatal: unknown option 'path-format'\\n\");",
      "    process.exit(129);",
      "  }",
      "}",
      "const r = spawnSync(__REAL_GIT__, args, { stdio: \"inherit\" });",
      "process.exit(r.status ?? 1);",
      "",
    ].join("\n"),
    realGit,
  );

it.effect(
  "R1: a Git that rejects --path-format still launches and captures an ordinary checkpoint",
  () =>
    Effect.gen(function* () {
      const realGit = resolveRealGitPath();
      const base = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-e3-pathformat-")),
      );
      const binDir = NodePath.join(base, "bin");
      const repo = NodePath.join(base, "repo");
      yield* Effect.promise(() => NodeFSP.mkdir(binDir, { recursive: true }));
      yield* Effect.promise(() => NodeFSP.mkdir(repo, { recursive: true }));
      writePathFormatRejectingGit(binDir, realGit);

      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = process.env.PATH;
          process.env.PATH = `${binDir}${NodePath.delimiter}${previous ?? ""}`;
          return previous;
        }),
        () =>
          Effect.gen(function* () {
            // 1. The launch preflight proceeds with no finding at all: a Git
            //    without `--path-format` is a harmless optional fallback.
            const preflight = yield* LaunchPreflight.LaunchPreflight;
            const result = yield* preflight.run(repo, { isSharedRoot: false });
            assert.deepStrictEqual(result.blockers, []);
            assert.deepStrictEqual(result.findings, []);

            // 2. An ordinary checkpoint succeeds through the temporary-index fallback.
            const driver = yield* GitVcsDriver.makeVcsDriverShape();
            const git = (args: ReadonlyArray<string>) =>
              driver.execute({ operation: "e3-path-format-test", cwd: repo, args });
            yield* git(["init"]);
            yield* git(["config", "user.name", "Test"]);
            yield* git(["config", "user.email", "test@test.com"]);
            yield* Effect.promise(() =>
              NodeFSP.writeFile(NodePath.join(repo, "file.txt"), "initial\n"),
            );
            yield* git(["add", "."]);
            yield* git(["commit", "-m", "initial"]);
            yield* Effect.promise(() =>
              NodeFSP.writeFile(NodePath.join(repo, "file.txt"), "changed\n"),
            );

            const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/e3-path-format");
            yield* driver.checkpoints.captureCheckpoint({ cwd: repo, checkpointRef });
            const shown = yield* git(["show", `${checkpointRef}:file.txt`]);
            assert.strictEqual(shown.stdout, "changed\n");
          }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.PATH;
            else process.env.PATH = previous;
          }),
      ).pipe(Effect.provide(E3CombinedLayer));

      yield* Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true }));
    }).pipe(Effect.scoped),
);

// --- R3 regression: real wall-clock bound and cleanup for a hung resolved Git -------------------

it.live(
  "R3: a hung resolved Git is bounded by wall-clock and the owned processes are cleaned up",
  () =>
    Effect.gen(function* () {
      const base = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-e3-hung-git-")),
      );
      const binDir = NodePath.join(base, "bin");
      const marker = NodePath.join(base, "finished");
      const childPidFile = NodePath.join(base, "child.pid");
      const grandchildPidFile = NodePath.join(base, "grandchild.pid");
      yield* Effect.promise(() => NodeFSP.mkdir(binDir, { recursive: true }));
      // The owned fixture records its own PID and the PID of a descendant it
      // spawns, then sleeps. Cleanup must terminate both, not just leave the
      // post-sleep marker unwritten.
      writeGitStub(
        binDir,
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));`,
          'const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });',
          `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(descendant.pid));`,
          `setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, "done"); process.exit(0); }, 30000);`,
          "",
        ].join("\n"),
        resolveRealGitPath(),
      );

      const isAlive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const readPid = (file: string) =>
        Effect.promise(() => NodeFSP.readFile(file, "utf8").then((raw) => Number(raw.trim())));

      const startedAt = yield* Clock.currentTimeMillis;
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = process.env.PATH;
          process.env.PATH = `${binDir}${NodePath.delimiter}${previous ?? ""}`;
          return previous;
        }),
        () =>
          Effect.gen(function* () {
            const preflight = yield* LaunchPreflight.LaunchPreflight;
            const result = yield* preflight.run(base, { isSharedRoot: false });
            const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
            assert.include(codes(result), "git-probe-timed-out");
            assert.isBelow(elapsedMs, 3000, `preflight took ${elapsedMs}ms`);

            const childPid = yield* readPid(childPidFile);
            const grandchildPid = yield* readPid(grandchildPidFile);
            assert.isTrue(Number.isInteger(childPid) && childPid > 0);
            assert.isTrue(Number.isInteger(grandchildPid) && grandchildPid > 0);

            // The hung wrapper and its descendant must have been terminated, not
            // left sleeping. Only the fixture's own captured PIDs are observed.
            yield* Effect.sleep("400 millis");
            assert.isFalse(isAlive(childPid), `owned child ${childPid} was not cleaned up`);
            assert.isFalse(
              isAlive(grandchildPid),
              `owned descendant ${grandchildPid} was not cleaned up`,
            );
            const finished = yield* Effect.promise(() =>
              NodeFSP.readFile(marker, "utf8").then(
                () => true,
                () => false,
              ),
            );
            assert.isFalse(finished, "hung git wrapper was not cleaned up");
          }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.PATH;
            else process.env.PATH = previous;
          }),
      ).pipe(Effect.provide(E3PreflightLayer));

      yield* Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true }));
    }).pipe(Effect.scoped),
);

// --- F1 regression: relative `--git-common-dir` resolves against the invocation cwd -------------

const makeRealGitProbe = Effect.gen(function* () {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const path = yield* Path.Path;
  return LaunchPreflight.makeGitProbe(vcsProcess, path);
});

const realpath = (target: string) => Effect.promise(() => NodeFSP.realpath(target));

/** Windows filesystem paths differ by case/separator; compare canonically. */
const sameRealPath = (actual: string, expected: string): boolean => {
  const normalize = (value: string) => {
    const resolved = NodePath.resolve(value);
    return isWindows ? resolved.toLowerCase() : resolved;
  };
  return normalize(actual) === normalize(expected);
};

it.live("F1: git identity resolves relative common dirs against the invocation cwd", () =>
  Effect.gen(function* () {
    const realGit = resolveRealGitPath();
    const base = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-e4-identity-")),
    );
    const repo = NodePath.join(base, "repo");
    const sub = NodePath.join(repo, "sub");
    const worktree = NodePath.join(base, "linked-worktree");
    const git = (cwd: string, args: ReadonlyArray<string>) =>
      Effect.promise(async () => {
        NodeChildProcess.execFileSync(realGit, args, { cwd });
      });

    yield* Effect.promise(() => NodeFSP.mkdir(sub, { recursive: true }));
    yield* git(repo, ["init"]);
    yield* git(repo, ["config", "user.name", "Test"]);
    yield* git(repo, ["config", "user.email", "test@test.com"]);
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(repo, "file.txt"), "hello\n"));
    yield* git(repo, ["add", "."]);
    yield* git(repo, ["commit", "-m", "initial"]);
    yield* git(repo, ["worktree", "add", worktree, "-b", "linked"]);

    const probe = yield* makeRealGitProbe;
    const repoReal = yield* realpath(repo);
    const repoGitDir = NodePath.join(repoReal, ".git");

    // 1. Root is the repository root: common dir is `<repo>/.git`.
    const rootIdentity = yield* probe.resolveIdentity(repo);
    assert.strictEqual(rootIdentity.state, "ok");
    assert.isTrue(sameRealPath(yield* realpath(rootIdentity.commonDir ?? ""), repoGitDir));

    // 2. Root is a subdirectory: plain `git rev-parse --git-common-dir` returns
    //    a relative `../.git`; it must resolve to `<repo>/.git`, not outside.
    const subIdentity = yield* probe.resolveIdentity(sub);
    assert.strictEqual(subIdentity.state, "ok");
    assert.isTrue(sameRealPath(yield* realpath(subIdentity.topLevel ?? ""), repoReal));
    assert.isTrue(sameRealPath(yield* realpath(subIdentity.commonDir ?? ""), repoGitDir));

    // 3. Root is a linked worktree: the common dir points back at the main
    //    repository, and its top level is the worktree itself.
    const worktreeIdentity = yield* probe.resolveIdentity(worktree);
    assert.strictEqual(worktreeIdentity.state, "ok");
    assert.isTrue(sameRealPath(yield* realpath(worktreeIdentity.commonDir ?? ""), repoGitDir));
    assert.isTrue(
      sameRealPath(yield* realpath(worktreeIdentity.topLevel ?? ""), yield* realpath(worktree)),
    );

    yield* Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true }));
  }).pipe(Effect.provide(E3VcsLayer)),
);

it.live("F3: the real probe reports git add --sparse support only for a sparse checkout", () =>
  Effect.gen(function* () {
    const realGit = resolveRealGitPath();
    const base = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-e4-sparse-")),
    );
    const repo = NodePath.join(base, "repo");
    const git = (args: ReadonlyArray<string>) =>
      Effect.promise(async () => {
        NodeChildProcess.execFileSync(realGit, args, { cwd: repo });
      });

    yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(repo, "src"), { recursive: true }));
    yield* git(["init"]);
    yield* git(["config", "user.name", "Test"]);
    yield* git(["config", "user.email", "test@test.com"]);
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(repo, "src", "file.txt"), "hello\n"),
    );
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "initial"]);

    const probe = yield* makeRealGitProbe;
    assert.strictEqual(yield* probe.isSparseCheckout(repo), false);
    // The selected OpenCode consumer requires `--sparse` even in an ordinary
    // repository, so its capability is probed regardless of the sparse config.
    assert.strictEqual(yield* probe.probeSparseAdd(repo), "supported");

    yield* git(["sparse-checkout", "set", "src"]);
    assert.strictEqual(yield* probe.isSparseCheckout(repo), true);
    assert.strictEqual(yield* probe.probeSparseAdd(repo), "supported");

    yield* Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true }));
  }).pipe(Effect.provide(E3VcsLayer)),
);

// --- A1/A2: consumer-driven `--sparse` applicability and the final launch env ----------------

/**
 * A `git` wrapper that lacks `git add --sparse`. It reports an `add -h` usage
 * without `--sparse` (the exact thing the probe reads), delegates every other
 * invocation to the real Git, and records its own path plus the harmless
 * environment sentinel it inherited. This models a provider environment whose
 * resolved Git is older than the host's.
 */
const writeSparseLessGit = (binDir: string, realGit: string, recordPath: string): void => {
  writeGitStub(
    binDir,
    [
      'import { appendFileSync } from "node:fs";',
      'import { spawnSync } from "node:child_process";',
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(recordPath)}, process.argv[1] + "|" + (process.env.ENVCHK_SENTINEL ?? "") + "\\n");`,
      'if (args[0] === "add" && args[1] === "-h") {',
      '  process.stdout.write("usage: git add [options] [--] <pathspec>...\\n    -n, --dry-run         dry run\\n    -v, --verbose         be verbose\\n");',
      "  process.exit(0);",
      "}",
      'const r = spawnSync(__REAL_GIT__, args, { stdio: "inherit" });',
      "process.exit(r.status ?? 1);",
      "",
    ].join("\n"),
    realGit,
  );
};

const ordinaryGitConsumer: LaunchPreflight.LaunchPreflightConsumer = {
  driver: "opencode",
  snapshotsEnabled: true,
};

const makeOrdinaryRepo = (repo: string, realGit: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => NodeFSP.mkdir(repo, { recursive: true }));
    const git = (args: ReadonlyArray<string>) =>
      Effect.promise(async () => {
        NodeChildProcess.execFileSync(realGit, args, { cwd: repo });
      });
    yield* git(["init"]);
    yield* git(["config", "user.name", "Test"]);
    yield* git(["config", "user.email", "test@test.com"]);
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(repo, "file.txt"), "hello\n"));
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "initial"]);
  });

it.live(
  "A1/A2: ordinary OpenCode repo resolves the selected provider Git and warns on missing --sparse",
  () =>
    Effect.gen(function* () {
      const realGit = resolveRealGitPath();
      const base = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-v5-consumer-")),
      );
      const repo = NodePath.join(base, "repo");
      const providerBin = NodePath.join(base, "provider-bin");
      const recordPath = NodePath.join(base, "record.log");
      const sentinel = "envchk-provider-sentinel";
      yield* Effect.promise(() => NodeFSP.mkdir(providerBin, { recursive: true }));
      writeSparseLessGit(providerBin, realGit, recordPath);
      yield* makeOrdinaryRepo(repo, realGit);

      const preflight = yield* LaunchPreflight.LaunchPreflight;

      // Host/default PATH resolves a capable Git: the ordinary repo passes even
      // for the OpenCode consumer.
      const healthy = yield* preflight.run(repo, { consumer: ordinaryGitConsumer });
      assert.deepStrictEqual(healthy.findings, []);

      // The selected provider environment resolves the controlled Git that
      // lacks `--sparse`; the ordinary (non-sparse) checkout still warns.
      const providerEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${providerBin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
        ENVCHK_SENTINEL: sentinel,
      };
      const warned = yield* preflight.run(repo, {
        consumer: ordinaryGitConsumer,
        gitEnvironment: providerEnvironment,
      });
      assert.deepStrictEqual(codes(warned), ["git-sparse-add-unsupported"]);
      assert.deepStrictEqual(severities(warned), ["warning"]);
      const message = warned.warnings[0]?.message ?? "";
      assert.include(message, "OpenCode");
      assert.include(message, "--sparse");

      // The selected executable and the harmless environment sentinel are the
      // ones from the provider environment, not the host default.
      const recorded = (yield* Effect.promise(() => NodeFSP.readFile(recordPath, "utf8"))).trim();
      const recordLines = recorded.split("\n");
      assert.isTrue(recordLines.length > 0);
      for (const line of recordLines) {
        const [executable, recordedSentinel] = line.split("|");
        // The wrapper ran from the selected provider environment's directory
        // (the launcher/stub lives in providerBin, not on the host).
        assert.strictEqual(NodePath.dirname(executable ?? ""), providerBin);
        assert.strictEqual(recordedSentinel, sentinel);
      }

      // Snapshot-disabled control: the same Git is not required by the consumer
      // (OpenCode snapshot staging off), so an ordinary checkout is silent.
      const disabled = yield* preflight.run(repo, {
        consumer: { driver: "opencode", snapshotsEnabled: false },
        gitEnvironment: providerEnvironment,
      });
      assert.deepStrictEqual(disabled.findings, []);

      // Non-OpenCode control: no provider-specific Git requirement is applied
      // globally to T3 sessions.
      const otherConsumer = yield* preflight.run(repo, {
        consumer: { driver: "codex", snapshotsEnabled: true },
        gitEnvironment: providerEnvironment,
      });
      assert.deepStrictEqual(otherConsumer.findings, []);

      // Non-Git control: a plain directory has no repository to checkpoint.
      const plain = NodePath.join(base, "plain");
      yield* Effect.promise(() => NodeFSP.mkdir(plain, { recursive: true }));
      const nonGit = yield* preflight.run(plain, {
        consumer: ordinaryGitConsumer,
        gitEnvironment: providerEnvironment,
      });
      assert.deepStrictEqual(nonGit.findings, []);

      yield* Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true }));
    }).pipe(Effect.provide(E3PreflightLayer)),
);
