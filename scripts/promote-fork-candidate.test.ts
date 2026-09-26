// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalProcessRuntime:off - Spawns the real promotion CLI as a child process with labeled fixtures.
/**
 * Process-level tests for the local/draft promotion handoff.
 *
 * These spawn `scripts/promote-fork-candidate.ts` against synthetic candidate
 * directories and a clearly-labeled `--preflight-json` GitHub fixture. The
 * `--execute` publication path is exercised against a mock `gh` script (via
 * `--gh-bin node --gh-prefix`), never the real GitHub API.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const VERSION = "0.0.43";
const SHA = "cb8a5b0b04b31cd9531e6bb8ebefcddaf1a1c4c2";

function scratch(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-promote-"));
}

function sha256(path: string): string {
  return NodeChildProcess.execFileSync(
    process.execPath,
    [
      "-e",
      "const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))",
      path,
    ],
    { encoding: "utf8" },
  ).trim();
}

interface Asset {
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
}

function writeCandidate(dir: string): Asset[] {
  const names = [
    `T3-Code-${VERSION}-x64.exe`,
    `T3-Code-${VERSION}-x64.dmg`,
    `t3-${VERSION}-linux-x64.tar.gz`,
    `t3-${VERSION}-win32-x64.zip`,
  ];
  const assets: Asset[] = names.map((name, index) => {
    const path = NodePath.join(dir, name);
    NodeFS.writeFileSync(path, Buffer.from(`asset-${index}-${name}`));
    return { name, sha256: sha256(path), size: NodeFS.statSync(path).size };
  });
  const receipts = [
    {
      schemaVersion: 1,
      owner: "W",
      target: "win32-x64",
      sourceSha: SHA,
      version: VERSION,
      assetName: names[0],
      assetSha256: assets[0]!.sha256,
      result: "pass",
    },
    {
      schemaVersion: 1,
      owner: "M",
      target: "darwin-x64",
      sourceSha: SHA,
      version: VERSION,
      assetName: names[1],
      assetSha256: assets[1]!.sha256,
      result: "pass",
    },
  ];
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
        assets,
        nativeReceipts: receipts,
      },
      null,
      2,
    )}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(dir, "SHA256SUMS"),
    `${assets
      .map((asset) => `${asset.sha256}  ${asset.name}`)
      .sort()
      .join("\n")}\n`,
  );
  return assets;
}

function writeEvidence(root: string, assets: ReadonlyArray<Asset>): string {
  const digest = (name: string): string => {
    const found = assets.find((asset) => asset.name === name);
    if (found === undefined) throw new Error(`fixture missing ${name}`);
    return found.sha256;
  };
  const installer = `T3-Code-${VERSION}-x64.exe`;
  const record = (platform: string, arch: string) => ({
    repository: "nullStack65/t3code",
    sourceSha: SHA,
    version: VERSION,
    platform,
    arch,
  });
  const evidence = {
    schemaVersion: 1,
    host: "r7-promote-fixture",
    records: {
      windowsDesktop: record("win", "x64"),
      windowsServerBundle: { name: "t3code-server", version: VERSION },
      embeddedWsl: record("linux", "x64"),
      windowsZip: record("win", "x64"),
      linuxArchive: record("linux", "x64"),
      macDmg: record("mac", "x64"),
    },
    digests: {
      windowsDesktop: digest(installer),
      windowsServerBundle: digest(installer),
      embeddedWsl: digest(installer),
      windowsZip: digest(`t3-${VERSION}-win32-x64.zip`),
      linuxArchive: digest(`t3-${VERSION}-linux-x64.tar.gz`),
      macDmg: digest(`T3-Code-${VERSION}-x64.dmg`),
    },
    embeddedWslEqualsStandalone: true,
  };
  const path = NodePath.join(root, "inspection-evidence.json");
  NodeFS.writeFileSync(path, JSON.stringify(evidence, null, 2));
  return path;
}

function writePreflight(root: string, onForkMain: boolean): string {
  const path = NodePath.join(root, "preflight.json");
  NodeFS.writeFileSync(
    path,
    JSON.stringify({
      releaseExists: false,
      tagExists: false,
      latestVersion: "0.0.42",
      authorizationGateReviewers: 1,
      onForkMain,
    }),
  );
  return path;
}

function writeMockGh(root: string): { readonly prefix: string; readonly log: string } {
  const script = NodePath.join(root, "mock-gh.js");
  const log = NodePath.join(root, "mock-gh.log");
  NodeFS.writeFileSync(
    script,
    [
      'const fs = require("node:fs");',
      "const log = process.env.GH_MOCK_LOG;",
      'if (log) fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");',
      "process.exit(0);",
    ].join("\n"),
  );
  return { prefix: script, log };
}

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runPromote(extraArgs: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}): RunResult {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    ["scripts/promote-fork-candidate.ts", ...extraArgs],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env } },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function baseArgs(candidateDir: string, preflight: string, evidence: string): string[] {
  return [
    "--candidate-dir",
    candidateDir,
    "--version",
    VERSION,
    "--sha",
    SHA,
    "--repository",
    "nullStack65/t3code",
    "--skip-provenance-inspection",
    "--inspection-evidence",
    evidence,
    "--preflight-json",
    preflight,
  ];
}

it("dry-run reports PROMOTION READY and performs no GitHub write (fixture)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const assets = writeCandidate(dir);
    const evidence = writeEvidence(root, assets);
    const preflight = writePreflight(root, true);
    const mock = writeMockGh(root);

    const result = runPromote(
      [
        ...baseArgs(dir, preflight, evidence),
        "--gh-bin",
        process.execPath,
        "--gh-prefix",
        mock.prefix,
      ],
      { GH_MOCK_LOG: mock.log },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "PROMOTION READY");
    assert.include(result.stdout, "release create v0.0.43");
    // The mock gh must never have been invoked: a dry run makes no write.
    assert.notOk(NodeFS.existsSync(mock.log));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("blocks a candidate-only SHA that is not on fork main (fixture)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const assets = writeCandidate(dir);
    const evidence = writeEvidence(root, assets);
    const preflight = writePreflight(root, false);
    const result = runPromote(baseArgs(dir, preflight, evidence));
    assert.equal(result.status, 1);
    assert.include(result.stderr, "not an ancestor of fork/main");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("blocks an incomplete candidate before any GitHub check (fixture)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const assets = writeCandidate(dir);
    const evidence = writeEvidence(root, assets);
    const preflight = writePreflight(root, true);
    NodeFS.rmSync(NodePath.join(dir, `T3-Code-${VERSION}-x64.exe`));
    const result = runPromote(baseArgs(dir, preflight, evidence));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /T3-Code-0\.0\.43-x64\.exe/);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("requires candidate-specific approval to execute (fixture)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const assets = writeCandidate(dir);
    const evidence = writeEvidence(root, assets);
    const preflight = writePreflight(root, true);
    const args = baseArgs(dir, preflight, evidence);

    const noApproval = runPromote([...args, "--execute"]);
    assert.equal(noApproval.status, 1);
    assert.include(noApproval.stderr, "--approve");

    const wrongApproval = runPromote([...args, "--execute", "--approve", "b".repeat(64)]);
    assert.equal(wrongApproval.status, 1);
    assert.include(wrongApproval.stderr, "does not match");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("executes the publication command against a mocked gh (fixture)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const assets = writeCandidate(dir);
    const evidence = writeEvidence(root, assets);
    const preflight = writePreflight(root, true);
    const mock = writeMockGh(root);
    const manifestDigest = sha256(NodePath.join(dir, "fork-release-manifest.json"));

    const result = runPromote(
      [
        ...baseArgs(dir, preflight, evidence),
        "--execute",
        "--approve",
        manifestDigest,
        "--gh-bin",
        process.execPath,
        "--gh-prefix",
        mock.prefix,
      ],
      { GH_MOCK_LOG: mock.log },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "Published v0.0.43");
    assert.ok(NodeFS.existsSync(mock.log));
    const logged = NodeFS.readFileSync(mock.log, "utf8");
    assert.include(logged, '"release"');
    assert.include(logged, '"create"');
    assert.include(logged, '"v0.0.43"');
    assert.include(logged, `T3-Code-${VERSION}-x64.exe`);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
