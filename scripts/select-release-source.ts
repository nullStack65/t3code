#!/usr/bin/env node
/**
 * Selects and verifies the exact source commit a fork release builds.
 *
 * Run from the release workspace after the bootstrap fetch. It re-runs the
 * selection authoritatively: fetch the requested SHA and `main`, check out the
 * explicit SHA, assert `HEAD` equals it, and assert the SHA is an ancestor of
 * `origin/main`. Writes `sha`, `head_sha`, and `workflow_sha` to `GITHUB_OUTPUT`
 * when available so a later job can bind provenance to the actual checkout.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import { selectReleaseSource } from "./lib/release-source.ts";

const command = Command.make(
  "select-release-source",
  {
    repoUrl: Flag.String("repo-url").pipe(
      Flag.withDescription("Git remote URL to fetch the release source from."),
    ),
    sha: Flag.String("sha").pipe(
      Flag.withDescription("Full 40-character source commit to check out."),
    ),
    mainRef: Flag.String("main-ref").pipe(
      Flag.withDescription("Branch the source must be an ancestor of."),
      Flag.withDefault("main"),
    ),
    cwd: Flag.String("cwd").pipe(
      Flag.withDescription("Workspace directory to run git in."),
      Flag.optional,
    ),
    githubOutput: Flag.Boolean("github-output").pipe(
      Flag.withDescription("Append sha/head_sha/workflow_sha to GITHUB_OUTPUT."),
      Flag.withDefault(false),
    ),
  },
  ({ repoUrl, sha, mainRef, cwd, githubOutput }) =>
    Effect.gen(function* () {
      const selected = yield* selectReleaseSource({
        cwd: Option.getOrElse(cwd, () => process.cwd()),
        repoUrl,
        sha,
        mainRef,
      });
      const workflowSha = process.env.GITHUB_SHA?.trim() ?? "";
      yield* Console.log(
        `Selected source ${selected.sha} (HEAD ${selected.headSha}, ancestor of origin/${selected.mainRef}, repo ${selected.repository})`,
      );
      if (workflowSha !== "" && workflowSha.toLowerCase() !== selected.sha) {
        yield* Console.log(
          `Workflow revision ${workflowSha} differs from the selected source; it is recorded separately, not as source provenance.`,
        );
      }
      if (githubOutput) {
        const outputPath = yield* Config.NonEmptyString("GITHUB_OUTPUT");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          outputPath,
          [
            `sha=${selected.sha}`,
            `head_sha=${selected.headSha}`,
            `workflow_sha=${workflowSha}`,
            "",
          ].join("\n"),
          { flag: "a" },
        );
      }
    }),
).pipe(Command.withDescription("Check out and verify the exact release source commit."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
