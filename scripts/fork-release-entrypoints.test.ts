// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Spawns the real CLI entry points as child processes.
/**
 * Process-level regression tests for the release entry points.
 *
 * These run the actual `node scripts/*.ts` entry points in isolated directories
 * rather than asserting against plan arrays, so argument parsing, exit codes,
 * and fail-closed behavior are exercised end to end.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { createPackage } from "@electron/asar";

import { assert, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const nodeBin = process.execPath;

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runNode(args: ReadonlyArray<string>, cwd = repoRoot): RunResult {
  const result = NodeChildProcess.spawnSync(nodeBin, [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, T3CODE_RELEASE_BUILD: "1" },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function scratch(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-entrypoint-"));
}

const VERSION = "0.0.43";
const SHA = "cb8a5b0b04b31cd9531e6bb8ebefcddaf1a1c4c2";

function writeCandidate(dir: string, options: { readonly withReceipts: boolean }): void {
  const assets = [
    `T3-Code-${VERSION}-x64.exe`,
    `T3-Code-${VERSION}-x64.dmg`,
    `t3-${VERSION}-linux-x64.tar.gz`,
    `t3-${VERSION}-win32-x64.zip`,
  ];
  for (const [index, name] of assets.entries()) {
    NodeFS.writeFileSync(NodePath.join(dir, name), Buffer.from(`asset-${index}-${name}`));
  }
  const observed = assets.map((name) => {
    const bytes = NodeFS.readFileSync(NodePath.join(dir, name));
    return {
      name,
      sha256: NodeChildProcess.execFileSync(
        nodeBin,
        [
          "-e",
          "const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))",
          NodePath.join(dir, name),
        ],
        { encoding: "utf8" },
      ).trim(),
      size: bytes.byteLength,
    };
  });
  const receipts = options.withReceipts
    ? [
        {
          schemaVersion: 1,
          owner: "W",
          target: "win32-x64",
          sourceSha: SHA,
          version: VERSION,
          assetName: assets[0],
          assetSha256: observed[0]!.sha256,
          result: "pass",
        },
        {
          schemaVersion: 1,
          owner: "M",
          target: "darwin-x64",
          sourceSha: SHA,
          version: VERSION,
          assetName: assets[1],
          assetSha256: observed[1]!.sha256,
          result: "pass",
        },
      ]
    : [];
  NodeFS.writeFileSync(
    NodePath.join(dir, "fork-release-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: "nullStack65/t3code",
        version: VERSION,
        sourceSha: SHA,
        workflowRevision: "local",
        workflowRunId: "local",
        workflowRunAttempt: "1",
        channel: "stable",
        createdAt: new Date().toISOString(),
        assets: observed,
        nativeReceipts: receipts,
      },
      null,
      2,
    )}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(dir, "SHA256SUMS"),
    `${observed
      .map((asset) => `${asset.sha256}  ${asset.name}`)
      .sort()
      .join("\n")}\n`,
  );
}

function sha256File(path: string): string {
  return NodeChildProcess.execFileSync(
    nodeBin,
    [
      "-e",
      "const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))",
      path,
    ],
    { encoding: "utf8" },
  ).trim();
}

/**
 * Complete digest-bound inspection evidence for the four-asset fixture candidate:
 * every packaged component names the expected source/version/platform/arch, each
 * record is bound to the exact observed artifact digest, and the embedded WSL
 * runtime is recorded as byte-identical to the standalone Linux archive.
 */
function completeInspectionEvidence(dir: string, sha = SHA): Record<string, unknown> {
  const exe = sha256File(NodePath.join(dir, `T3-Code-${VERSION}-x64.exe`));
  const zip = sha256File(NodePath.join(dir, `t3-${VERSION}-win32-x64.zip`));
  const tar = sha256File(NodePath.join(dir, `t3-${VERSION}-linux-x64.tar.gz`));
  const dmg = sha256File(NodePath.join(dir, `T3-Code-${VERSION}-x64.dmg`));
  const record = (platform: string) => ({
    repository: "nullStack65/t3code",
    sourceSha: sha,
    version: VERSION,
    platform,
    arch: "x64",
  });
  return {
    schemaVersion: 1,
    host: "test-fixture",
    records: {
      windowsDesktop: record("win"),
      windowsServerBundle: { name: "t3code-server", version: VERSION },
      embeddedWsl: record("linux"),
      windowsZip: record("win"),
      linuxArchive: record("linux"),
      macDmg: record("mac"),
    },
    digests: {
      windowsDesktop: exe,
      windowsServerBundle: exe,
      embeddedWsl: exe,
      windowsZip: zip,
      linuxArchive: tar,
      macDmg: dmg,
    },
    embeddedWslEqualsStandalone: true,
  };
}

it("the aggregate verifier accepts a complete candidate and rejects a partial one (real process)", () => {
  const root = scratch();
  try {
    const complete = NodePath.join(root, "complete");
    NodeFS.mkdirSync(complete);
    writeCandidate(complete, { withReceipts: true });
    const accepted = runNode([
      "scripts/verify-fork-candidate.ts",
      "--candidate-dir",
      complete,
      "--version",
      VERSION,
      "--sha",
      SHA,
      "--repository",
      "nullStack65/t3code",
      "--skip-provenance-inspection",
    ]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.include(accepted.stdout, "Candidate verified");

    const partial = NodePath.join(root, "partial");
    NodeFS.mkdirSync(partial);
    NodeFS.copyFileSync(
      NodePath.join(complete, `t3-${VERSION}-linux-x64.tar.gz`),
      NodePath.join(partial, `t3-${VERSION}-linux-x64.tar.gz`),
    );
    NodeFS.copyFileSync(
      NodePath.join(complete, "fork-release-manifest.json"),
      NodePath.join(partial, "fork-release-manifest.json"),
    );
    const rejected = runNode([
      "scripts/verify-fork-candidate.ts",
      "--candidate-dir",
      partial,
      "--version",
      VERSION,
      "--sha",
      SHA,
      "--repository",
      "nullStack65/t3code",
      "--skip-provenance-inspection",
    ]);
    assert.equal(rejected.status, 1);
    assert.include(rejected.stderr, "required asset");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("per-target verification passes with only that platform's bytes (real process)", () => {
  const root = scratch();
  try {
    const linuxOnly = NodePath.join(root, "linux-only");
    NodeFS.mkdirSync(linuxOnly);
    NodeFS.writeFileSync(
      NodePath.join(linuxOnly, `t3-${VERSION}-linux-x64.tar.gz`),
      Buffer.from("linux"),
    );
    // Deliberately no fork-release-manifest.json: per-target verification must
    // not require the aggregate manifest that only exists after the freeze.
    const result = runNode([
      "scripts/verify-fork-candidate.ts",
      "--candidate-dir",
      linuxOnly,
      "--version",
      VERSION,
      "--sha",
      SHA,
      "--repository",
      "nullStack65/t3code",
      "--targets",
      "linux",
      "--skip-provenance-inspection",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "Per-target verification passed");

    // A wrong-target asset must be rejected: a Windows-target check needs the
    // Windows installer and CLI ZIP, which are absent here.
    const wrongTarget = runNode([
      "scripts/verify-fork-candidate.ts",
      "--candidate-dir",
      linuxOnly,
      "--version",
      VERSION,
      "--sha",
      SHA,
      "--repository",
      "nullStack65/t3code",
      "--targets",
      "win",
      "--skip-provenance-inspection",
    ]);
    assert.equal(wrongTarget.status, 1);
    assert.include(wrongTarget.stderr, "missing");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("the verifier rejects conflicting receipts through the real process", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "conflict");
    NodeFS.mkdirSync(dir);
    writeCandidate(dir, { withReceipts: true });
    const manifestPath = NodePath.join(dir, "fork-release-manifest.json");
    const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
      nativeReceipts: Array<Record<string, unknown>>;
      assets: Array<{ name: string; sha256: string }>;
    };
    manifest.nativeReceipts.push({
      schemaVersion: 1,
      owner: "W2",
      target: "win32-x64",
      sourceSha: SHA,
      version: VERSION,
      assetName: `T3-Code-${VERSION}-x64.exe`,
      assetSha256: manifest.assets[0]!.sha256,
      result: "fail",
      notes: "crashed",
    });
    NodeFS.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const result = runNode([
      "scripts/verify-fork-candidate.ts",
      "--candidate-dir",
      dir,
      "--version",
      VERSION,
      "--sha",
      SHA,
      "--repository",
      "nullStack65/t3code",
      "--require-native-receipts",
      "--skip-provenance-inspection",
    ]);
    assert.equal(result.status, 1);
    assert.include(result.stderr, "conflicting");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses --promote --skip-provenance-inspection without inspection evidence (real process)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "promote");
    NodeFS.mkdirSync(dir);
    writeCandidate(dir, { withReceipts: true });

    const commonArgs = [
      "scripts/verify-fork-candidate.ts",
      "--candidate-dir",
      dir,
      "--version",
      VERSION,
      "--sha",
      SHA,
      "--repository",
      "nullStack65/t3code",
      "--promote",
      "--tag-target",
      SHA,
      "--latest-version",
      "0.0.42",
      "--authorization-gate-exists",
      "--skip-provenance-inspection",
    ];

    // No packaged inspection happened and no digest-bound evidence was supplied:
    // promotion must fail closed instead of qualifying uninspected bytes.
    const bypass = runNode(commonArgs);
    assert.equal(bypass.status, 1, bypass.stderr);
    assert.include(bypass.stderr, "packaged provenance inspection is required");

    // The same invocation succeeds when valid digest-bound native evidence for
    // the exact bytes is supplied: skipping local extraction is allowed, skipping
    // the provenance requirement is not.
    const evidencePath = NodePath.join(root, "native-inspection-evidence.json");
    NodeFS.writeFileSync(
      evidencePath,
      JSON.stringify(completeInspectionEvidence(dir), null, 2),
    );
    const accepted = runNode([...commonArgs, "--inspection-evidence", evidencePath]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.include(accepted.stdout, "Promotion checks passed");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

interface FixtureAsset {
  readonly id: number;
  readonly name: string;
  readonly digest: string;
  readonly size: number;
}

function writePromotableCandidate(
  dir: string,
  sha: string,
): { identityDigest: string; assets: ReadonlyArray<FixtureAsset> } {
  const names = [
    `T3-Code-${VERSION}-x64.exe`,
    `T3-Code-${VERSION}-x64.dmg`,
    `t3-${VERSION}-linux-x64.tar.gz`,
    `t3-${VERSION}-win32-x64.zip`,
  ];
  const assets: FixtureAsset[] = names.map((name, index) => {
    const bytes = Buffer.from(`promote-asset-${index}-${name}`);
    NodeFS.writeFileSync(NodePath.join(dir, name), bytes);
    return {
      id: 700000 + index,
      name,
      digest: `sha256:${sha256File(NodePath.join(dir, name))}`,
      size: bytes.byteLength,
    };
  });
  const receipts = [
    {
      schemaVersion: 1,
      owner: "W",
      target: "win32-x64",
      sourceSha: sha,
      version: VERSION,
      assetName: names[0],
      assetSha256: assets[0]!.digest.replace(/^sha256:/, ""),
      result: "pass",
    },
    {
      schemaVersion: 1,
      owner: "M",
      target: "darwin-x64",
      sourceSha: sha,
      version: VERSION,
      assetName: names[1],
      assetSha256: assets[1]!.digest.replace(/^sha256:/, ""),
      result: "pass",
    },
  ];
  const manifest = {
    schemaVersion: 1,
    repository: "nullStack65/t3code",
    version: VERSION,
    sourceSha: sha,
    workflowRevision: "local",
    workflowRunId: "local",
    workflowRunAttempt: "1",
    channel: "stable",
    createdAt: "2026-09-23T00:00:00.000Z",
    assets: assets.map((asset) => ({
      name: asset.name,
      sha256: asset.digest.replace(/^sha256:/, ""),
      size: asset.size,
    })),
    nativeReceipts: receipts,
  };
  const manifestPath = NodePath.join(dir, "fork-release-manifest.json");
  NodeFS.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const identityDigest = sha256File(manifestPath);
  NodeFS.writeFileSync(
    NodePath.join(dir, "candidate-identity.json"),
    `${JSON.stringify({ sourceSha: sha, version: VERSION, manifestSha256: identityDigest, assets: manifest.assets }, null, 2)}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(dir, "SHA256SUMS"),
    `${manifest.assets.map((asset) => `${asset.sha256}  ${asset.name}`).sort().join("\n")}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(dir, "fork-inspection-evidence-all.json"),
    `${JSON.stringify(completeInspectionEvidence(dir, sha), null, 2)}\n`,
  );
  return { identityDigest, assets };
}

function setupForkMain(root: string): { work: string; sha: string } {
  const bare = NodePath.join(root, "fork.git");
  const work = NodePath.join(root, "work");
  NodeFS.mkdirSync(bare);
  NodeFS.mkdirSync(work);
  const git = (cwd: string, args: ReadonlyArray<string>): string =>
    NodeChildProcess.execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", ...args],
      { cwd, encoding: "utf8" },
    ).trim();
  git(bare, ["init", "--bare"]);
  git(work, ["init"]);
  git(work, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  NodeFS.writeFileSync(NodePath.join(work, "a.txt"), "a\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-m", "A"]);
  git(work, ["remote", "add", "fork", bare]);
  git(work, ["push", "fork", "main"]);
  return { work, sha: git(work, ["rev-parse", "HEAD"]) };
}

it("promotes a complete candidate as a simulated publication dry run (real process, mocked GitHub)", () => {
  const root = scratch();
  try {
    const { work, sha } = setupForkMain(root);
    const candidate = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(candidate);
    const { identityDigest, assets } = writePromotableCandidate(candidate, sha);
    const fixture = NodePath.join(root, "github.json");
    NodeFS.writeFileSync(
      fixture,
      JSON.stringify({
        releaseExists: false,
        tagExists: false,
        latestVersion: "0.0.42",
        requiredReviewers: 2,
        draft: { tag: `candidate-r4-v${VERSION}-${sha.slice(0, 12)}`, targetSha: sha, assets },
      }),
    );

    const result = runNode(
      [
        "scripts/promote-fork-candidate.ts",
        "--candidate-dir",
        candidate,
        "--version",
        VERSION,
        "--sha",
        sha,
        "--repository",
        "nullStack65/t3code",
        "--draft-release",
        `candidate-r4-v${VERSION}-${sha.slice(0, 12)}`,
        "--github-fixture",
        fixture,
        "--approve",
        identityDigest,
      ],
      work,
    );
    assert.equal(result.status, 0, result.stderr);
    // This is a simulated publication: verification + dry run only, no release.
    assert.include(result.stdout, "Promotion verification passed");
    assert.include(result.stdout, "DRY RUN — no release was created");
    assert.include(result.stdout, "draft asset 700000");
    assert.include(result.stdout, `is an ancestor of fork/main`);
    assert.include(result.stdout, `Publication approved for candidate ${identityDigest}`);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("stops a promotion that lacks explicit candidate approval (real process, mocked GitHub)", () => {
  const root = scratch();
  try {
    const { work, sha } = setupForkMain(root);
    const candidate = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(candidate);
    writePromotableCandidate(candidate, sha);
    const fixture = NodePath.join(root, "github.json");
    NodeFS.writeFileSync(
      fixture,
      JSON.stringify({
        releaseExists: false,
        tagExists: false,
        latestVersion: "0.0.42",
        requiredReviewers: 2,
      }),
    );
    const result = runNode(
      [
        "scripts/promote-fork-candidate.ts",
        "--candidate-dir",
        candidate,
        "--version",
        VERSION,
        "--sha",
        sha,
        "--repository",
        "nullStack65/t3code",
        "--github-fixture",
        fixture,
      ],
      work,
    );
    assert.equal(result.status, 1);
    assert.include(result.stderr, "explicit publication approval is required");
    assert.notInclude(result.stdout, "DRY RUN");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("stops an off-main candidate before any write (real process, mocked GitHub)", () => {
  const root = scratch();
  try {
    const { work, sha } = setupForkMain(root);
    // A second commit that is not on fork/main.
    const git = (args: ReadonlyArray<string>): string =>
      NodeChildProcess.execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", ...args],
        { cwd: work, encoding: "utf8" },
      ).trim();
    NodeFS.writeFileSync(NodePath.join(work, "b.txt"), "b\n");
    git(["add", "."]);
    git(["commit", "-m", "B"]);
    const offMain = git(["rev-parse", "HEAD"]);

    const candidate = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(candidate);
    const { identityDigest } = writePromotableCandidate(candidate, offMain);
    const fixture = NodePath.join(root, "github.json");
    NodeFS.writeFileSync(
      fixture,
      JSON.stringify({
        releaseExists: false,
        tagExists: false,
        latestVersion: "0.0.42",
        requiredReviewers: 2,
      }),
    );
    const result = runNode(
      [
        "scripts/promote-fork-candidate.ts",
        "--candidate-dir",
        candidate,
        "--version",
        VERSION,
        "--sha",
        offMain,
        "--repository",
        "nullStack65/t3code",
        "--github-fixture",
        fixture,
        "--approve",
        identityDigest,
      ],
      work,
    );
    assert.equal(result.status, 1);
    assert.include(result.stderr, "is not an ancestor of nullStack65/t3code main");
    assert.notInclude(result.stdout, "DRY RUN");
    assert.ok(sha !== offMain);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("stops the real incomplete draft because Windows assets and acceptance are missing (real draft metadata fixture)", () => {
  const root = scratch();
  try {
    // The exact asset ids/digests of draft release 395230248 at the time of the
    // R6 repair: Intel Mac DMG + Linux runtime + inspection evidence only.
    const fixture = NodePath.join(root, "real-draft.json");
    NodeFS.writeFileSync(
      fixture,
      JSON.stringify({
        releaseExists: false,
        tagExists: false,
        latestVersion: "0.0.42",
        requiredReviewers: 0,
        draft: {
          tag: "candidate-r4-v0.0.43-929b63795",
          targetSha: "929b63795e7696855ada61de5fd359dc2f51da78",
          assets: [
            {
              id: 584947074,
              name: `T3-Code-${VERSION}-x64.dmg`,
              digest: "sha256:01af27ad8ed509f6f4af8ccc1d054999fccf6d7c47f1c70f9b461858f951ae68",
              size: 140516937,
            },
            {
              id: 585058463,
              name: `t3-${VERSION}-linux-x64.tar.gz`,
              digest: "sha256:a8d8a519dc572451f19167246fdba0d8eb92cf7d53ec498097b0b3e636c81772",
              size: 64106782,
            },
          ],
        },
      }),
    );
    const result = runNode([
      "scripts/promote-fork-candidate.ts",
      "--draft-release",
      "candidate-r4-v0.0.43-929b63795",
      "--version",
      VERSION,
      "--sha",
      "929b63795e7696855ada61de5fd359dc2f51da78",
      "--repository",
      "nullStack65/t3code",
      "--github-fixture",
      fixture,
    ]);
    assert.equal(result.status, 1);
    assert.include(result.stderr, `required asset T3-Code-${VERSION}-x64.exe is missing`);
    assert.include(result.stderr, `required asset t3-${VERSION}-win32-x64.zip is missing`);
    assert.include(result.stderr, "no native acceptance receipt for win32-x64");
    // It must stop before the dry-run plan (and therefore before any write).
    assert.notInclude(result.stdout, "DRY RUN");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("inspects real packaged provenance from a real Linux tar.gz (real process)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "real");
    NodeFS.mkdirSync(dir);
    // Build a real tarball whose build-info names the expected source.
    const staging = NodePath.join(root, "staging");
    const stem = `t3-${VERSION}-linux-x64`;
    NodeFS.mkdirSync(NodePath.join(staging, stem), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(staging, stem, "t3code-build-info.json"),
      JSON.stringify({
        schemaVersion: 1,
        repository: "nullStack65/t3code",
        sourceSha: SHA,
        workflowRevision: "local",
        version: VERSION,
        platform: "linux",
        arch: "x64",
        channel: "stable",
      }),
    );
    const archive = NodePath.join(dir, `${stem}.tar.gz`);
    NodeChildProcess.execFileSync("tar", ["-czf", archive, "-C", staging, stem]);
    const observed = NodeChildProcess.execFileSync(
      nodeBin,
      [
        "-e",
        "const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))",
        archive,
      ],
      { encoding: "utf8" },
    ).trim();
    NodeFS.writeFileSync(
      NodePath.join(dir, "fork-release-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        repository: "nullStack65/t3code",
        version: VERSION,
        sourceSha: SHA,
        workflowRevision: "local",
        workflowRunId: "local",
        workflowRunAttempt: "1",
        channel: "stable",
        createdAt: new Date().toISOString(),
        assets: [{ name: `${stem}.tar.gz`, sha256: observed, size: NodeFS.statSync(archive).size }],
        nativeReceipts: [],
      }),
    );

    const ok = runNode([
      "scripts/verify-fork-candidate.ts",
      "--candidate-dir",
      dir,
      "--version",
      VERSION,
      "--sha",
      SHA,
      "--repository",
      "nullStack65/t3code",
      "--targets",
      "linux",
    ]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.include(ok.stdout, "Inspected packaged provenance");
    assert.include(ok.stdout, `"sourceSha": "${SHA}"`);

    // Now corrupt the embedded provenance: a candidate built from another
    // source must be rejected by the real inspection, not just the manifest.
    const otherStaging = NodePath.join(root, "other");
    NodeFS.mkdirSync(NodePath.join(otherStaging, stem), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(otherStaging, stem, "t3code-build-info.json"),
      JSON.stringify({
        schemaVersion: 1,
        repository: "nullStack65/t3code",
        sourceSha: "a".repeat(40),
        workflowRevision: "local",
        version: VERSION,
        platform: "linux",
        arch: "x64",
        channel: "stable",
      }),
    );
    NodeChildProcess.execFileSync("tar", ["-czf", archive, "-C", otherStaging, stem]);
    const corruptHash = NodeChildProcess.execFileSync(
      nodeBin,
      [
        "-e",
        "const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))",
        archive,
      ],
      { encoding: "utf8" },
    ).trim();
    const manifestPath = NodePath.join(dir, "fork-release-manifest.json");
    const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
      assets: Array<{ name: string; sha256: string; size: number }>;
    };
    manifest.assets[0]!.sha256 = corruptHash;
    manifest.assets[0]!.size = NodeFS.statSync(archive).size;
    NodeFS.writeFileSync(manifestPath, JSON.stringify(manifest));
    NodeFS.writeFileSync(NodePath.join(dir, "SHA256SUMS"), `${corruptHash}  ${stem}.tar.gz\n`);
    const rejected = runNode([
      "scripts/verify-fork-candidate.ts",
      "--candidate-dir",
      dir,
      "--version",
      VERSION,
      "--sha",
      SHA,
      "--repository",
      "nullStack65/t3code",
      "--targets",
      "linux",
    ]);
    assert.equal(rejected.status, 1);
    assert.include(rejected.stderr, "provenance sourceSha");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

function writeBuildInfoArchive(
  archivePath: string,
  stagingRoot: string,
  info: Record<string, unknown>,
): string {
  const stem = `t3-${VERSION}-linux-x64`;
  const staging = NodePath.join(stagingRoot, "build-info-staging");
  NodeFS.mkdirSync(NodePath.join(staging, stem), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(staging, stem, "t3code-build-info.json"),
    JSON.stringify(info),
  );
  NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", staging, stem]);
  return archivePath;
}

it("rejects arbitrary non-DMG bytes under the expected DMG filename (real process)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "bogus-dmg");
    NodeFS.mkdirSync(dir);
    NodeFS.writeFileSync(
      NodePath.join(dir, `T3-Code-${VERSION}-x64.dmg`),
      Buffer.from("not a dmg"),
    );
    const result = runNode([
      "scripts/verify-fork-candidate.ts",
      "--candidate-dir",
      dir,
      "--version",
      VERSION,
      "--sha",
      SHA,
      "--repository",
      "nullStack65/t3code",
      "--targets",
      "mac",
    ]);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Intel macOS DMG has no readable packaged provenance|Intel macOS DMG provenance was required but was not inspected/,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("rejects a real archive with no readable build-info (real process)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "no-info");
    NodeFS.mkdirSync(dir);
    const stem = `t3-${VERSION}-linux-x64`;
    const staging = NodePath.join(root, "staging");
    NodeFS.mkdirSync(NodePath.join(staging, stem), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(staging, stem, "t3"), "binary\n");
    NodeChildProcess.execFileSync("tar", [
      "-czf",
      NodePath.join(dir, `${stem}.tar.gz`),
      "-C",
      staging,
      stem,
    ]);
    const result = runNode([
      "scripts/verify-fork-candidate.ts",
      "--candidate-dir",
      dir,
      "--version",
      VERSION,
      "--sha",
      SHA,
      "--repository",
      "nullStack65/t3code",
      "--targets",
      "linux",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Linux runtime archive has no readable packaged provenance/);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("rejects wrong repo/SHA/version/platform/arch in a real archive (real process)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "wrong-fields");
    NodeFS.mkdirSync(dir);
    writeBuildInfoArchive(NodePath.join(dir, `t3-${VERSION}-linux-x64.tar.gz`), root, {
      schemaVersion: 1,
      repository: "someone/else",
      sourceSha: "a".repeat(40),
      workflowRevision: "local",
      version: "9.9.9",
      platform: "win",
      arch: "arm64",
      channel: "stable",
    });
    const result = runNode([
      "scripts/verify-fork-candidate.ts",
      "--candidate-dir",
      dir,
      "--version",
      VERSION,
      "--sha",
      SHA,
      "--repository",
      "nullStack65/t3code",
      "--targets",
      "linux",
    ]);
    assert.equal(result.status, 1);
    const failures = result.stderr;
    assert.match(failures, /Linux runtime archive provenance repository is someone\/else/);
    assert.match(failures, /Linux runtime archive provenance sourceSha is a{40}/);
    assert.match(failures, /Linux runtime archive provenance version is 9\.9\.9/);
    assert.match(failures, /Linux runtime archive provenance platform is win, expected linux/);
    assert.match(failures, /Linux runtime archive provenance arch is arm64, expected x64/);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("fails a required Windows desktop inspection that did not happen (real process)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "win-uninspected");
    NodeFS.mkdirSync(dir);
    // Arbitrary bytes for both the installer and the CLI ZIP: neither carries a
    // readable build info, and on a host without 7-Zip the NSIS components are
    // simply not inspectable. Either way this is BLOCKED, not verified.
    NodeFS.writeFileSync(NodePath.join(dir, `T3-Code-${VERSION}-x64.exe`), Buffer.from("nope"));
    NodeFS.writeFileSync(NodePath.join(dir, `t3-${VERSION}-win32-x64.zip`), Buffer.from("nope"));
    const result = runNode([
      "scripts/verify-fork-candidate.ts",
      "--candidate-dir",
      dir,
      "--version",
      VERSION,
      "--sha",
      SHA,
      "--repository",
      "nullStack65/t3code",
      "--targets",
      "win",
    ]);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Windows desktop application provenance was required but was not inspected|Windows desktop application has no readable packaged provenance/,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

// eslint-disable-next-line t3code/no-global-process-runtime -- selecting a host-specific integration test, not Effect code
const itMac = it.skipIf(process.platform !== "darwin");

itMac("inspects a real macOS DMG's app.asar provenance (real process)", async () => {
  const root = scratch();
  try {
    const appSrc = NodePath.join(root, "appsrc");
    const resources = NodePath.join(root, "stage", "T3 Code (Alpha).app", "Contents", "Resources");
    NodeFS.mkdirSync(appSrc, { recursive: true });
    NodeFS.mkdirSync(resources, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(appSrc, "t3code-build-info.json"),
      JSON.stringify({
        schemaVersion: 1,
        repository: "nullStack65/t3code",
        sourceSha: SHA,
        workflowRevision: "local",
        version: VERSION,
        platform: "mac",
        arch: "x64",
        channel: "stable",
      }),
    );
    await createPackage(appSrc, NodePath.join(resources, "app.asar"));

    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const dmg = NodePath.join(dir, `T3-Code-${VERSION}-x64.dmg`);
    NodeChildProcess.execFileSync("hdiutil", [
      "create",
      "-volname",
      "T3 Code",
      "-srcfolder",
      NodePath.join(root, "stage"),
      "-ov",
      "-format",
      "UDZO",
      dmg,
    ]);

    const accepted = runNode([
      "scripts/verify-fork-candidate.ts",
      "--candidate-dir",
      dir,
      "--version",
      VERSION,
      "--sha",
      SHA,
      "--repository",
      "nullStack65/t3code",
      "--targets",
      "mac",
    ]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.include(accepted.stdout, "Per-target verification passed");
    assert.include(accepted.stdout, '"platform": "mac"');
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("the source selector accepts a candidate-mode fork SHA (real process)", () => {
  const root = scratch();
  try {
    const origin = NodePath.join(root, "origin");
    const work = NodePath.join(root, "work");
    NodeFS.mkdirSync(origin);
    NodeFS.mkdirSync(work);
    const git = (cwd: string, args: ReadonlyArray<string>): string =>
      NodeChildProcess.execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", ...args],
        { cwd, encoding: "utf8" },
      ).trim();
    git(origin, ["init"]);
    git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    // Older git refuses to serve an unadvertised object over the local transport.
    git(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    NodeFS.writeFileSync(NodePath.join(origin, "a.txt"), "a\n");
    git(origin, ["add", "."]);
    git(origin, ["commit", "-m", "A"]);
    git(origin, ["checkout", "-b", "feature"]);
    NodeFS.writeFileSync(NodePath.join(origin, "b.txt"), "b\n");
    git(origin, ["add", "."]);
    git(origin, ["commit", "-m", "B"]);
    const head = git(origin, ["rev-parse", "HEAD"]);
    git(origin, ["checkout", "main"]);

    const result = runNode(
      [
        "scripts/select-release-source.ts",
        "--repo-url",
        origin,
        "--sha",
        head,
        "--main-ref",
        "main",
        "--mode",
        "candidate",
        "--cwd",
        work,
      ],
      repoRoot,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "mode candidate");
    assert.include(result.stdout, "ancestry on-fork");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
