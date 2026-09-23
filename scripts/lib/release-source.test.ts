// @effect-diagnostics nodeBuiltinImport:off - Sets up real git repositories to exercise the selection sequence end to end.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  InvalidSourceShaError,
  SourceNotOnMainError,
  normalizeSourceSha,
  selectReleaseSource,
} from "./release-source.ts";

const isSourceNotOnMain = Schema.is(SourceNotOnMainError);
const isInvalidSourceSha = Schema.is(InvalidSourceShaError);

const git = (cwd: string, args: readonly string[]): string =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();

interface Fixture {
  readonly root: string;
  readonly origin: string;
  readonly work: string;
  readonly shaA: string;
  readonly shaB: string;
  readonly shaOffMain: string;
}

/**
 * Builds a remote with two commits on `main` (A then B) plus a commit on a
 * side branch that is not an ancestor of `main`.
 */
async function createFixture(): Promise<Fixture> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-release-source-"));
  const origin = NodePath.join(root, "origin");
  const work = NodePath.join(root, "work");
  await NodeFSP.mkdir(origin, { recursive: true });
  await NodeFSP.mkdir(work, { recursive: true });

  git(origin, ["init", "-b", "main"]);
  await NodeFSP.writeFile(NodePath.join(origin, "a.txt"), "a\n");
  git(origin, ["add", "."]);
  git(origin, ["commit", "-m", "A"]);
  const shaA = git(origin, ["rev-parse", "HEAD"]);

  await NodeFSP.writeFile(NodePath.join(origin, "b.txt"), "b\n");
  git(origin, ["add", "."]);
  git(origin, ["commit", "-m", "B"]);
  const shaB = git(origin, ["rev-parse", "HEAD"]);

  git(origin, ["checkout", "-b", "feature"]);
  await NodeFSP.writeFile(NodePath.join(origin, "c.txt"), "c\n");
  git(origin, ["add", "."]);
  git(origin, ["commit", "-m", "C"]);
  const shaOffMain = git(origin, ["rev-parse", "HEAD"]);
  git(origin, ["checkout", "main"]);

  return { root, origin, work, shaA, shaB, shaOffMain };
}

const cleanup = (root: string) => NodeFSP.rm(root, { recursive: true, force: true });

it.layer(NodeServices.layer)("release-source", (it) => {
  it.effect("checks out the requested older SHA even after fetching newer main", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(createFixture);
      try {
        const selected = yield* selectReleaseSource({
          cwd: fixture.work,
          repoUrl: fixture.origin,
          sha: fixture.shaA,
          mainRef: "main",
        });

        assert.equal(selected.sha, fixture.shaA);
        assert.equal(selected.headSha, fixture.shaA);
        // The real checkout is the requested source, not main's tip.
        assert.equal(git(fixture.work, ["rev-parse", "HEAD"]), fixture.shaA);
        assert.notEqual(git(fixture.work, ["rev-parse", "HEAD"]), fixture.shaB);
        // Ancestry is verified separately and passes for an on-main commit.
        git(fixture.work, ["merge-base", "--is-ancestor", fixture.shaA, "origin/main"]);
      } finally {
        yield* Effect.promise(() => cleanup(fixture.root));
      }
    }),
  );

  it.effect("demonstrates the old FETCH_HEAD sequence selected main, then fixes it", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(createFixture);
      try {
        // Reproduce the previous sequence: fetch the requested SHA, fetch main,
        // then check out FETCH_HEAD. The second fetch wins, so HEAD is main.
        git(fixture.work, ["init", "-b", "main"]);
        git(fixture.work, ["remote", "add", "origin", fixture.origin]);
        git(fixture.work, ["fetch", "--no-tags", "--depth=1", "origin", fixture.shaA]);
        git(fixture.work, ["fetch", "--no-tags", "origin", "main"]);
        git(fixture.work, ["checkout", "--detach", "FETCH_HEAD"]);
        assert.equal(git(fixture.work, ["rev-parse", "HEAD"]), fixture.shaB);

        // The repaired selector must end on the requested source.
        const selected = yield* selectReleaseSource({
          cwd: fixture.work,
          repoUrl: fixture.origin,
          sha: fixture.shaA,
          mainRef: "main",
        });
        assert.equal(selected.headSha, fixture.shaA);
        assert.equal(git(fixture.work, ["rev-parse", "HEAD"]), fixture.shaA);
      } finally {
        yield* Effect.promise(() => cleanup(fixture.root));
      }
    }),
  );

  it.effect("accepts a SHA that is the tip of main", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(createFixture);
      try {
        const selected = yield* selectReleaseSource({
          cwd: fixture.work,
          repoUrl: fixture.origin,
          sha: fixture.shaB,
          mainRef: "main",
        });
        assert.equal(selected.headSha, fixture.shaB);
      } finally {
        yield* Effect.promise(() => cleanup(fixture.root));
      }
    }),
  );

  it.effect("rejects a commit that is not an ancestor of main", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(createFixture);
      try {
        const error = yield* selectReleaseSource({
          cwd: fixture.work,
          repoUrl: fixture.origin,
          sha: fixture.shaOffMain,
          mainRef: "main",
        }).pipe(Effect.flip);
        assert.isTrue(isSourceNotOnMain(error));
      } finally {
        yield* Effect.promise(() => cleanup(fixture.root));
      }
    }),
  );

  it.effect("rejects a SHA that is not a full 40-character commit", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(createFixture);
      try {
        const error = yield* selectReleaseSource({
          cwd: fixture.work,
          repoUrl: fixture.origin,
          sha: "bcc1a58",
          mainRef: "main",
        }).pipe(Effect.flip);
        assert.isTrue(isInvalidSourceSha(error));
      } finally {
        yield* Effect.promise(() => cleanup(fixture.root));
      }
    }),
  );

  it("normalizes only full SHAs", () => {
    assert.equal(
      normalizeSourceSha("  BCC1A58B19A9D610A4F08FED191A364767BC65B3 "),
      "bcc1a58b19a9d610a4f08fed191a364767bc65b3",
    );
    assert.equal(normalizeSourceSha("bcc1a58"), undefined);
    assert.equal(normalizeSourceSha("not-a-sha"), undefined);
    assert.equal(normalizeSourceSha(undefined), undefined);
  });
});
