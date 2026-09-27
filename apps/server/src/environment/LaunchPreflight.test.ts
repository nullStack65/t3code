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
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as LaunchPreflight from "./LaunchPreflight.ts";

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
  probeIndexFastPath: () => Effect.succeed("supported"),
  ...overrides,
});

const input = (options: {
  readonly root?: string;
  readonly isSharedRoot?: boolean;
  readonly git?: LaunchPreflight.LaunchPreflightGitProbe;
  readonly files?: Partial<LaunchPreflight.LaunchPreflightFileProbe>;
}): LaunchPreflight.LaunchPreflightInput => ({
  root: options.root ?? "/session-root",
  ...(options.isSharedRoot !== undefined ? { isSharedRoot: options.isSharedRoot } : {}),
  git: options.git ?? gitProbe(),
  files: {
    exists: () => Effect.succeed(false),
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
    assert.include(result.warnings[0]?.message ?? "", "/Documents/.git");
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
        files: { exists: (target) => Effect.succeed(target === "/repo/.git") },
      }),
    );

    assert.deepStrictEqual(severities(result), ["blocker"]);
    assert.include(result.blockers[0]?.message ?? "", "could not be started");
  }),
);

it.effect("warns but never blocks when Git lacks --path-format, even at a repository root", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/repo",
        isSharedRoot: true,
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(identity({ state: "ok", topLevel: "/repo", commonDir: "/repo/.git" })),
          probeIndexFastPath: () => Effect.succeed("unsupported"),
        }),
        files: { exists: (target) => Effect.succeed(target === "/repo/.git") },
      }),
    );

    assert.deepStrictEqual(result.blockers, []);
    assert.include(codes(result), "git-index-fast-path-unavailable");
    const message = result.findings.find(
      (f) => f.code === "git-index-fast-path-unavailable",
    )?.message;
    assert.notInclude(message ?? "", "2.31.0");
    assert.include(message ?? "", "still");
  }),
);

it.effect("warns when the resolved Git lacks --path-format but the root is not a repository", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        git: gitProbe({ probeIndexFastPath: () => Effect.succeed("unsupported") }),
      }),
    );

    assert.deepStrictEqual(codes(result), ["git-index-fast-path-unavailable"]);
    assert.deepStrictEqual(severities(result), ["warning"]);
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

it.effect("resolves within the total budget even when the first probe hangs", () =>
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
const writePathFormatRejectingGit = (binDir: string, realGit: string) => {
  const wrapperPath = NodePath.join(binDir, "git");
  NodeFS.writeFileSync(
    wrapperPath,
    [
      "#!/bin/sh",
      'for a in "$@"; do',
      '  case "$a" in',
      "    --path-format|--path-format=*)",
      "      echo \"fatal: unknown option 'path-format'\" >&2",
      "      exit 129",
      "      ;;",
      "  esac",
      "done",
      `exec "${realGit}" "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return wrapperPath;
};

it.effect(
  "R1: a Git that rejects --path-format still launches and captures an ordinary checkpoint",
  () =>
    Effect.gen(function* () {
      const realGit = NodeChildProcess.execFileSync("which", ["git"]).toString().trim();
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
            // 1. The launch preflight proceeds: no blocker, at most warnings.
            const preflight = yield* LaunchPreflight.LaunchPreflight;
            const result = yield* preflight.run(repo, { isSharedRoot: false });
            assert.deepStrictEqual(result.blockers, []);
            assert.ok(
              result.findings.every((finding) => finding.severity === "warning"),
              "expected only warnings from the rejecting Git fixture",
            );
            assert.include(codes(result), "git-index-fast-path-unavailable");

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

it.live("R3: a hung resolved Git is bounded by wall-clock and the child is cleaned up", () =>
  Effect.gen(function* () {
    const base = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-e3-hung-git-")),
    );
    const binDir = NodePath.join(base, "bin");
    const marker = NodePath.join(base, "finished");
    yield* Effect.promise(() => NodeFSP.mkdir(binDir, { recursive: true }));
    NodeFS.writeFileSync(NodePath.join(binDir, "git"), `#!/bin/sh\nsleep 30\ntouch "${marker}"\n`, {
      mode: 0o755,
    });

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

          // The hung wrapper must have been terminated, not left sleeping.
          yield* Effect.sleep("400 millis");
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
