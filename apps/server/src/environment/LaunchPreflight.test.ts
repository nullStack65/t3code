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

const gitVersion = (version: string | null): LaunchPreflight.LaunchPreflightGitProbe => ({
  version: () => Effect.succeed(version),
});

const input = (options: {
  readonly root?: string;
  readonly git?: LaunchPreflight.LaunchPreflightGitProbe;
  readonly files?: Partial<LaunchPreflight.LaunchPreflightFileProbe>;
}): LaunchPreflight.LaunchPreflightInput => ({
  root: options.root ?? "/session-root",
  git: options.git ?? gitVersion("2.55.0"),
  files: {
    exists: () => Effect.succeed(false),
    readFirstBytes: () => Effect.succeed(16),
    listDirectory: () => Effect.succeed([]),
    ...options.files,
  },
});

const codes = (result: LaunchPreflight.LaunchPreflightResult) =>
  result.warnings.map((warning) => warning.code);

const run = (probeInput: LaunchPreflight.LaunchPreflightInput) =>
  LaunchPreflight.runLaunchPreflight(probeInput).pipe(Effect.provide(NodeServices.layer));

it.effect("passes an ordinary repository session with a supported Git", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        files: {
          exists: (target) => Effect.succeed(target.endsWith("package.json")),
        },
      }),
    );

    assert.deepStrictEqual(result.warnings, []);
  }),
);

it.effect("passes a non-Git shared session root", () =>
  Effect.gen(function* () {
    const result = yield* run(input({}));

    assert.deepStrictEqual(result.warnings, []);
  }),
);

it.effect("flags an old, incompatible Git with an actionable message", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({ git: gitVersion("2.24.3") }),
    );

    assert.deepStrictEqual(codes(result), ["git-too-old"]);
    assert.include(result.warnings[0]?.message ?? "", "2.24.3");
    assert.include(result.warnings[0]?.message ?? "", LaunchPreflight.MINIMUM_GIT_VERSION);
  }),
);

it.effect("flags an accidental umbrella repository at the shared root", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/Documents",
        files: {
          exists: (target) =>
            Effect.succeed(target === "/Documents/.git" || target === "/Documents/proj/.git"),
          listDirectory: () => Effect.succeed(["proj", "notes"]),
        },
      }),
    );

    assert.deepStrictEqual(codes(result), ["shared-root-git"]);
  }),
);

it.effect("does not flag an ordinary repository root that has no nested repositories", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({
        root: "/repo",
        files: {
          exists: (target) => Effect.succeed(target === "/repo/.git"),
          listDirectory: () => Effect.succeed(["src", "docs"]),
        },
      }),
    );

    assert.deepStrictEqual(result.warnings, []);
  }),
);

it.effect("flags a Git executable that cannot start", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({ git: { version: () => Effect.fail(probeError("unavailable")) } }),
    );

    assert.deepStrictEqual(codes(result), ["git-startup-failed"]);
  }),
);

it.effect("flags a Git probe that reports a timeout", () =>
  Effect.gen(function* () {
    const result = yield* run(
      input({ git: { version: () => Effect.fail(probeError("timeout")) } }),
    );

    assert.deepStrictEqual(codes(result), ["git-probe-timed-out"]);
  }),
);

it.effect("bounds a hung Git probe instead of holding the launch", () =>
  Effect.gen(function* () {
    const fiber = yield* run(
      input({ git: { version: () => Effect.never } }),
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("3 seconds");
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
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(fiber);

    assert.deepStrictEqual(codes(result), ["root-read-slow"]);
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
              stdout: processInput.command === "git" ? "git version 2.55.0\n" : "",
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

    assert.deepStrictEqual(result.warnings, []);
    yield* Effect.promise(() => NodeFS.rm(directory, { recursive: true, force: true }));
  }),
);
