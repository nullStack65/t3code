import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  BUILD_INFO_FILE_NAME,
  createBuildInfo,
  parseBuildInfo,
  parseSourceRepository,
  readGitSourceProvenance,
  resolveBuildChannel,
  resolveSourceRepository,
  resolveSourceSha,
  serializeBuildInfo,
} from "./source-provenance.ts";

const FULL_SHA = "bcc1a58b19a9d610a4f08fed191a364767bc65b3";

it("names the readable provenance file", () => {
  assert.equal(BUILD_INFO_FILE_NAME, "t3code-build-info.json");
});

it("normalizes repository remotes to owner/repo", () => {
  assert.equal(parseSourceRepository("nullStack65/t3code"), "nullStack65/t3code");
  assert.equal(
    parseSourceRepository("https://github.com/nullStack65/t3code"),
    "nullStack65/t3code",
  );
  assert.equal(
    parseSourceRepository("https://github.com/nullStack65/t3code.git"),
    "nullStack65/t3code",
  );
  assert.equal(
    parseSourceRepository("git@github.com:nullStack65/t3code.git"),
    "nullStack65/t3code",
  );
  assert.equal(
    parseSourceRepository("ssh://git@github.com/nullStack65/t3code.git"),
    "nullStack65/t3code",
  );
  assert.equal(parseSourceRepository("not-a-repo"), undefined);
  assert.equal(parseSourceRepository(undefined), undefined);
});

it("prefers an explicit repository and SHA over GitHub Actions and the fork default", () => {
  assert.equal(
    resolveSourceRepository({
      T3CODE_SOURCE_REPOSITORY: "explicit/fork",
      GITHUB_REPOSITORY: "actions/repo",
    }),
    "explicit/fork",
  );
  assert.equal(resolveSourceRepository({ GITHUB_REPOSITORY: "actions/repo" }), "actions/repo");
  // A local fork worktree usually names upstream `origin`; the default must
  // still be the fork so a local build is never labelled as an upstream build.
  assert.equal(resolveSourceRepository({}), "nullStack65/t3code");

  assert.equal(
    resolveSourceSha({ T3CODE_SOURCE_SHA: FULL_SHA, GITHUB_SHA: "a".repeat(40) }),
    FULL_SHA,
  );
  assert.equal(resolveSourceSha({ GITHUB_SHA: FULL_SHA }), FULL_SHA);
  assert.equal(resolveSourceSha({ GITHUB_SHA: "not-a-sha" }), "unknown");
  assert.equal(resolveSourceSha({}, undefined), "unknown");
});

it("labels fork releases by channel and rejects non-stable labels for a plain version", () => {
  assert.equal(resolveBuildChannel("0.0.43"), "stable");
  assert.equal(resolveBuildChannel("0.0.43-nightly.20260923.1"), "nightly");
  assert.equal(resolveBuildChannel("0.0.43-preview.20260923.1"), "preview");
});

it.effect("serializes provenance that round-trips and carries every required field", () =>
  Effect.gen(function* () {
    const info = createBuildInfo({
      version: "0.0.43",
      platform: "win",
      arch: "x64",
      repository: "nullStack65/t3code",
      sourceSha: FULL_SHA,
    });
    const parsed = parseBuildInfo(yield* serializeBuildInfo(info));
    assert.deepStrictEqual(parsed, {
      schemaVersion: 1,
      repository: "nullStack65/t3code",
      sourceSha: FULL_SHA,
      version: "0.0.43",
      platform: "win",
      arch: "x64",
      channel: "stable",
    });
  }),
);

it.effect("falls back to unknown rather than omitting fields", () =>
  Effect.gen(function* () {
    const info = createBuildInfo({ version: "0.0.43", platform: "mac", arch: "x64" });
    assert.equal(info.repository, "unknown");
    assert.equal(info.sourceSha, "unknown");
    const parsed = parseBuildInfo(yield* serializeBuildInfo(info));
    assert.equal(parsed.repository, "unknown");
    assert.equal(parsed.sourceSha, "unknown");
  }),
);

it.effect("reads a full HEAD sha from the git checkout", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const repoRoot = yield* path.fromFileUrl(new URL("../../", import.meta.url));
    const git = yield* readGitSourceProvenance(repoRoot);
    assert.match(git.sourceSha, /^[0-9a-f]{40}$/);
  }).pipe(Effect.provide(NodeServices.layer)),
);
