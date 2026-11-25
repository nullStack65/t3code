import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { configureTestGitEnv } from "./gitConfig.setup.ts";

const runCleanGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const env: NodeJS.ProcessEnv = { ...process.env };
    configureTestGitEnv(env);
    const handle = yield* spawner.spawn(
      ChildProcess.make("git", args, { cwd, env, extendEnv: false }),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [
        Stream.runCollect(handle.stdout).pipe(
          Effect.map((chunks) => Buffer.concat(chunks).toString("utf8").trim()),
        ),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    expect(Number(exitCode)).toBe(0);
    return stdout;
  }).pipe(Effect.scoped);

describe("git test environment scrub", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("strips inherited GIT_* variables and sets deterministic fixture git config", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      GIT_DIR: "/scratch/.git",
      GIT_WORK_TREE: "/scratch",
      GIT_INDEX_FILE: "/scratch/.git/index",
      GIT_COMMON_DIR: "/scratch/.git",
      git_object_directory: "/scratch/.git/objects",
      GIT_CONFIG_PARAMETERS: "'user.name=Leaked'",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Leaked",
    };

    configureTestGitEnv(env);

    expect(env.PATH).toBe("/usr/bin");
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_COMMON_DIR).toBeUndefined();
    expect(env.git_object_directory).toBeUndefined();
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBe("6");
    expect(env.GIT_CONFIG_KEY_0).toBe("core.autocrlf");
    expect(env.GIT_CONFIG_VALUE_0).toBe("false");
    expect(env.GIT_CONFIG_KEY_3).toBe("commit.gpgsign");
    expect(env.GIT_CONFIG_VALUE_3).toBe("false");
    expect(env.GIT_CONFIG_KEY_5).toBe("init.defaultBranch");
    expect(env.GIT_CONFIG_VALUE_5).toBe("main");
  });

  it.effect(
    "prevents checkpointWorkspace from leaking into a scratch non-bare repo under GIT_DIR and GIT_INDEX_FILE",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const scratchDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-git-scrub-non-bare-",
        });
        yield* runCleanGit(scratchDir, ["init"]);
        yield* runCleanGit(scratchDir, ["config", "user.name", "Scratch Owner"]);
        yield* runCleanGit(scratchDir, ["config", "user.email", "scratch@example.invalid"]);
        yield* fs.writeFileString(path.join(scratchDir, "scratch.txt"), "baseline\n");
        yield* runCleanGit(scratchDir, ["add", "scratch.txt"]);
        yield* runCleanGit(scratchDir, ["commit", "-m", "scratch baseline"]);

        const beforeHead = yield* runCleanGit(scratchDir, ["rev-parse", "HEAD"]);
        const scratchGitDir = path.join(scratchDir, ".git");
        vi.stubEnv("GIT_DIR", scratchGitDir);
        vi.stubEnv("GIT_WORK_TREE", scratchDir);
        vi.stubEnv("GIT_COMMON_DIR", scratchGitDir);
        vi.stubEnv("GIT_INDEX_FILE", path.join(scratchGitDir, "index"));

        const workspace = yield* checkpointWorkspace("scrub-non-bare");

        expect(yield* runCleanGit(workspace, ["log", "-1", "--format=%s"])).toBe("initial");
        expect(yield* runCleanGit(scratchDir, ["rev-parse", "HEAD"])).toBe(beforeHead);
        expect(yield* runCleanGit(scratchDir, ["rev-list", "--count", "HEAD"])).toBe("1");
        expect(yield* runCleanGit(scratchDir, ["config", "--local", "user.name"])).toBe(
          "Scratch Owner",
        );
        expect(yield* runCleanGit(scratchDir, ["config", "--local", "user.email"])).toBe(
          "scratch@example.invalid",
        );
        expect(yield* runCleanGit(scratchDir, ["status", "--porcelain"])).toBe("");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "prevents checkpointWorkspace from leaking into a scratch bare repo under GIT_DIR and GIT_INDEX_FILE",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const bareDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-git-scrub-bare-",
        });
        yield* runCleanGit(bareDir, ["init", "--bare"]);

        const scratchIndex = path.join(bareDir, "index");
        vi.stubEnv("GIT_DIR", bareDir);
        vi.stubEnv("GIT_INDEX_FILE", scratchIndex);

        const workspace = yield* checkpointWorkspace("scrub-bare");

        expect(yield* runCleanGit(workspace, ["log", "-1", "--format=%s"])).toBe("initial");
        expect(yield* runCleanGit(bareDir, ["for-each-ref"])).toBe("");
        expect(yield* runCleanGit(bareDir, ["config", "--local", "--list"])).not.toContain(
          "T3 Code Test",
        );
        expect(yield* fs.exists(scratchIndex)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
