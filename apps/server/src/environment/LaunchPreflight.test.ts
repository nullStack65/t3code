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
import * as Path from "effect/Path";
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
  probeSparseAdd: () => Effect.succeed("not-sparse"),
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
          probeSparseAdd: () => Effect.succeed("not-sparse"),
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
      NodeFS.writeFileSync(
        NodePath.join(binDir, "git"),
        [
          "#!/bin/sh",
          `echo $$ > "${childPidFile}"`,
          "sleep 30 &",
          `echo $! > "${grandchildPidFile}"`,
          "wait",
          `touch "${marker}"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
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

it.live("F1: git identity resolves relative common dirs against the invocation cwd", () =>
  Effect.gen(function* () {
    const realGit = NodeChildProcess.execFileSync("which", ["git"]).toString().trim();
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

    // 1. Root is the repository root: common dir is `<repo>/.git`.
    const rootIdentity = yield* probe.resolveIdentity(repo);
    assert.strictEqual(rootIdentity.state, "ok");
    assert.strictEqual(yield* realpath(rootIdentity.commonDir ?? ""), `${repoReal}/.git`);

    // 2. Root is a subdirectory: plain `git rev-parse --git-common-dir` returns
    //    a relative `../.git`; it must resolve to `<repo>/.git`, not outside.
    const subIdentity = yield* probe.resolveIdentity(sub);
    assert.strictEqual(subIdentity.state, "ok");
    assert.strictEqual(yield* realpath(subIdentity.topLevel ?? ""), repoReal);
    assert.strictEqual(yield* realpath(subIdentity.commonDir ?? ""), `${repoReal}/.git`);

    // 3. Root is a linked worktree: the common dir points back at the main
    //    repository, and its top level is the worktree itself.
    const worktreeIdentity = yield* probe.resolveIdentity(worktree);
    assert.strictEqual(worktreeIdentity.state, "ok");
    assert.strictEqual(yield* realpath(worktreeIdentity.commonDir ?? ""), `${repoReal}/.git`);
    assert.strictEqual(yield* realpath(worktreeIdentity.topLevel ?? ""), yield* realpath(worktree));

    yield* Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true }));
  }).pipe(Effect.provide(E3VcsLayer)),
);

it.live("F3: the real probe reports git add --sparse support only for a sparse checkout", () =>
  Effect.gen(function* () {
    const realGit = NodeChildProcess.execFileSync("which", ["git"]).toString().trim();
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
    assert.strictEqual(yield* probe.probeSparseAdd(repo), "not-sparse");

    yield* git(["sparse-checkout", "set", "src"]);
    assert.strictEqual(yield* probe.probeSparseAdd(repo), "supported");

    yield* Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true }));
  }).pipe(Effect.provide(E3VcsLayer)),
);
