// @effect-diagnostics nodeBuiltinImport:off - real temp directories exercise the bounded read probe.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as LaunchPreflight from "./LaunchPreflight.ts";

const probeError = (
  reason: LaunchPreflight.LaunchPreflightProbeFailureReason,
  detail = "probe failed",
) => new LaunchPreflight.LaunchPreflightProbeError({ reason, detail });

const identity = (
  overrides: Partial<LaunchPreflight.LaunchPreflightRepoIdentity> = {},
): LaunchPreflight.LaunchPreflightRepoIdentity => ({
  state: "ok",
  topLevel: "/session-root",
  commonDir: "/session-root/.git",
  detail: "",
  ...overrides,
});

const gitProbe = (
  overrides: Partial<LaunchPreflight.LaunchPreflightGitProbe> = {},
): LaunchPreflight.LaunchPreflightGitProbe => ({
  version: () => Effect.succeed("2.55.0"),
  resolveIdentity: () => Effect.succeed(identity({ state: "not-a-repository", topLevel: null, commonDir: null })),
  ...overrides,
});

const input = (options: {
  readonly root?: string;
  readonly git?: LaunchPreflight.LaunchPreflightGitProbe;
  readonly files?: Partial<LaunchPreflight.LaunchPreflightFileProbe>;
}): LaunchPreflight.LaunchPreflightInput => ({
  root: options.root ?? "/session-root",
  git: options.git ?? gitProbe(),
  files: {
    exists: () => Effect.succeed(false),
    readFirstBytes: () => Effect.succeed(16),
    listDirectory: () => Effect.succeed([]),
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
            Effect.succeed(identity({ topLevel: "/repo", commonDir: "/repo/.git" })),
        }),
        files: {
          exists: (target) => Effect.succeed(target === "/repo/.git" || target.endsWith("package.json")),
          listDirectory: () => Effect.succeed(["src", "docs"]),
        },
      }),
    );

    assert.deepStrictEqual(result.findings, []);
  }),
);

it.effect("passes a non-Git shared session root", () =>
  Effect.gen(function* () {
    const result = yield* run(input({}));

    assert.deepStrictEqual(result.findings, []);
  }),
);

it.effect("does not count a retired Git marker as an umbrella by its name alone", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/Documents",
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(identity({ state: "not-a-repository", topLevel: null, commonDir: null })),
        }),
        files: {
          exists: (target) => Effect.succeed(target === "/Documents/.git.macfix-m1-retired"),
          listDirectory: () => Effect.succeed([]),
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
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(identity({ topLevel: "/Documents", commonDir: "/Documents/.git" })),
        }),
        files: {
          exists: (target) =>
            Effect.succeed(target === "/Documents/.git" || target === "/Documents/proj/.git"),
          listDirectory: () => Effect.succeed(["proj", "notes"]),
        },
      }),
    );

    assert.deepStrictEqual(codes(result), ["shared-root-git"]);
    assert.deepStrictEqual(severities(result), ["warning"]);
  }),
);

it.effect("does not flag an ordinary repository root that has no nested repositories", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/repo",
        git: gitProbe({
          resolveIdentity: () => Effect.succeed(identity({ topLevel: "/repo" })),
        }),
        files: {
          exists: (target) => Effect.succeed(target === "/repo/.git" || target.endsWith("package.json")),
          listDirectory: () => Effect.succeed(["src", "docs"]),
        },
      }),
    );

    assert.deepStrictEqual(result.findings, []);
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
    assert.include(result.blockers[0]?.message ?? "", "/repo/.git");
  }),
);

it.effect("blocks when the resolved Git lacks --path-format and the root is a repository", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/repo",
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(
              identity({ state: "unsupported", topLevel: null, commonDir: null, detail: "git 2.24.3" }),
            ),
        }),
        files: { exists: (target) => Effect.succeed(target === "/repo/.git") },
      }),
    );

    assert.deepStrictEqual(severities(result), ["blocker"]);
    assert.include(result.blockers[0]?.message ?? "", "2.24.3");
  }),
);

it.effect("warns when the resolved Git lacks --path-format but the root is not a repository", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        git: gitProbe({
          resolveIdentity: () =>
            Effect.succeed(identity({ state: "unsupported", topLevel: null, commonDir: null })),
        }),
      }),
    );

    assert.deepStrictEqual(codes(result), ["git-capability-missing"]);
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
    const fiber = yield* run(
      input({ git: { ...gitProbe(), version: () => Effect.never } }),
    ).pipe(Effect.forkChild);
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

it.effect("resolves every probe within the total budget even when all probes hang", () =>
  Effect.gen(function* () {
    const fiber = yield* run(
      input({
        git: { ...gitProbe(), version: () => Effect.never },
        files: {
          exists: () => Effect.never,
          listDirectory: () => Effect.never,
          readFirstBytes: () => Effect.never,
        },
      }),
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("5 seconds");
    const result = yield* Fiber.join(fiber);

    assert.deepStrictEqual(codes(result), ["git-probe-timed-out"]);
  }),
);

it.effect("wires the real service probes and passes a healthy root", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-launch-preflight-")),
    );
    yield* Effect.promise(() =>
      NodeFS.writeFile(NodePath.join(directory, "package.json"), '{"name":"preflight"}\n'),
    );

    const layer = LaunchPreflight.layer.pipe(
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (processInput) =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout:
                processInput.args.includes("--version")
                  ? "git version 2.55.0\n"
                  : `${directory}\n${NodePath.join(directory, ".git")}\n`,
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
    yield* Effect.promise(() => NodeFS.rm(directory, { recursive: true, force: true }));
  }),
);
