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
    const observed = NodeChildProcess.execFileSync(
      nodeBin,
      [
        "-e",
        "const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))",
        NodePath.join(linuxOnly, `t3-${VERSION}-linux-x64.tar.gz`),
      ],
      { encoding: "utf8" },
    ).trim();
    NodeFS.writeFileSync(
      NodePath.join(linuxOnly, "fork-release-manifest.json"),
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
        assets: [{ name: `t3-${VERSION}-linux-x64.tar.gz`, sha256: observed, size: 5 }],
        nativeReceipts: [],
      }),
    );
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
    git(origin, ["init", "-b", "main"]);
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
