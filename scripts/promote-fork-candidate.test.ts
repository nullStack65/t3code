// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalProcessRuntime:off - Spawns the real promotion CLI as a child process with labeled fixtures.
/**
 * Process-level tests for the local/draft promotion handoff.
 *
 * These spawn `scripts/promote-fork-candidate.ts` against synthetic candidate
 * directories. The offline mode (`--simulate`) uses a clearly-labeled
 * `--preflight-json` GitHub fixture plus a *stateful* fake GitHub transport (a
 * mock `gh` script reached via `--gh-bin node --gh-prefix`) that records the
 * exact uploaded files and serves them back on `release download`. That lets the
 * tests assert on the uploaded file *contents*, the draft → upload → readback →
 * verify → finalize sequence, and that partial uploads or changed bytes never
 * reach finalization. The live GitHub API is never contacted.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const VERSION = "0.0.43";
const SHA = "cb8a5b0b04b31cd9531e6bb8ebefcddaf1a1c4c2";
const RUNTIME = `t3-${VERSION}-linux-x64.tar.gz`;
const INSTALLER = `T3-Code-${VERSION}-x64.exe`;

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
  const names = [INSTALLER, `T3-Code-${VERSION}-x64.dmg`, RUNTIME, `t3-${VERSION}-win32-x64.zip`];
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
  const record = (platform: string, arch: string) => ({
    repository: "nullStack65/t3code",
    sourceSha: SHA,
    version: VERSION,
    platform,
    arch,
  });
  const evidence = {
    schemaVersion: 1,
    host: "r8-promote-fixture",
    records: {
      windowsDesktop: record("win", "x64"),
      windowsServerBundle: { name: "t3code-server", version: VERSION },
      embeddedWsl: record("linux", "x64"),
      windowsZip: record("win", "x64"),
      linuxArchive: record("linux", "x64"),
      macDmg: record("mac", "x64"),
    },
    digests: {
      windowsDesktop: digest(INSTALLER),
      windowsServerBundle: digest(INSTALLER),
      embeddedWsl: digest(INSTALLER),
      windowsZip: digest(`t3-${VERSION}-win32-x64.zip`),
      linuxArchive: digest(RUNTIME),
      macDmg: digest(`T3-Code-${VERSION}-x64.dmg`),
    },
    embeddedWslEqualsStandalone: true,
  };
  const path = NodePath.join(root, "inspection-evidence.json");
  NodeFS.writeFileSync(path, JSON.stringify(evidence, null, 2));
  return path;
}

function writePreflight(root: string, override: Record<string, unknown> = {}): string {
  const path = NodePath.join(root, "preflight.json");
  NodeFS.writeFileSync(
    path,
    JSON.stringify({
      releaseExists: false,
      tagExists: false,
      latestVersion: "0.0.42",
      authorizationGateReviewers: 1,
      onForkMain: true,
      ...override,
    }),
  );
  return path;
}

/**
 * A stateful offline fake GitHub transport. It implements the exact gh
 * subcommands the publisher uses (`release view/create/upload/download/edit`),
 * copying uploaded files into a state directory so readback is exercised on the
 * real bytes. Env knobs inject failures without touching GitHub.
 */
const MOCK_GH_SOURCE = `const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const stateDir = process.env.GH_MOCK_STATE;
const log = process.env.GH_MOCK_LOG;
if (log) fs.appendFileSync(log, JSON.stringify(argv) + "\\n");

function parse(rest) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) flags[token.slice(2, eq)] = token.slice(eq + 1);
      else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) {
        flags[token.slice(2)] = rest[i + 1];
        i += 1;
      } else flags[token.slice(2)] = true;
    } else positional.push(token);
  }
  return { positional, flags };
}

const { positional, flags } = parse(argv);
const stateFile = path.join(stateDir, "release.json");
const storeDir = path.join(stateDir, "store");

function readState() {
  return fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : undefined;
}
function writeState(state) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
function finish(code, stdout, stderr) {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}

if (positional[0] === "release" && positional[1] === "view") {
  const state = readState();
  if (!state) finish(1, "", "release not found\\n");
  const omit = process.env.GH_MOCK_OMIT;
  const assets = omit ? state.assets.filter((a) => a.name !== omit) : state.assets;
  finish(0, JSON.stringify({ ...state, assets }));
}

if (positional[0] === "release" && positional[1] === "create") {
  if (process.env.GH_MOCK_FAIL_CREATE === "1") finish(1, "", "create rejected\\n");
  const tag = positional[2];
  writeState({ id: 4242, tag_name: tag, name: tag, draft: true, target_commitish: flags.target || "", assets: [] });
  finish(0, "");
}

if (positional[0] === "release" && positional[1] === "upload") {
  if (process.env.GH_MOCK_FAIL_UPLOAD === "1") finish(1, "", "upload rejected\\n");
  const state = readState() || { id: 4242, tag_name: "", draft: true, assets: [] };
  fs.mkdirSync(storeDir, { recursive: true });
  for (const file of positional.slice(3)) {
    fs.copyFileSync(file, path.join(storeDir, path.basename(file)));
    state.assets.push({ name: path.basename(file), size: fs.statSync(file).size, state: "uploaded" });
  }
  writeState(state);
  finish(0, "");
}

if (positional[0] === "release" && positional[1] === "download") {
  const state = readState();
  if (!state) finish(1, "", "release not found\\n");
  fs.mkdirSync(flags.dir, { recursive: true });
  for (const name of fs.readdirSync(storeDir)) {
    let bytes = fs.readFileSync(path.join(storeDir, name));
    if (process.env.GH_MOCK_CORRUPT === name) bytes = Buffer.concat([bytes, Buffer.from("corrupt")]);
    fs.writeFileSync(path.join(flags.dir, name), bytes);
  }
  finish(0, "");
}

if (positional[0] === "release" && positional[1] === "edit") {
  const state = readState();
  if (!state) finish(1, "", "release not found\\n");
  if (flags.draft === "false") state.draft = false;
  if (flags.latest === true) state.isLatest = true;
  writeState(state);
  finish(0, "");
}

finish(2, "", "mock gh: unhandled command " + argv.join(" ") + "\\n");
`;

interface MockGh {
  readonly prefix: string;
  readonly log: string;
  readonly state: string;
}

function writeMockGh(root: string): MockGh {
  const script = NodePath.join(root, "mock-gh.js");
  NodeFS.writeFileSync(script, MOCK_GH_SOURCE);
  return {
    prefix: script,
    log: NodePath.join(root, "mock-gh.log"),
    state: NodePath.join(root, "gh-state"),
  };
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
    "--simulate",
  ];
}

function mockArgs(mock: MockGh): string[] {
  return ["--gh-bin", process.execPath, "--gh-prefix", mock.prefix];
}

function mockEnv(mock: MockGh, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { GH_MOCK_STATE: mock.state, GH_MOCK_LOG: mock.log, ...extra };
}

it("dry-run reports PROMOTION READY and performs no GitHub write (simulated)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const assets = writeCandidate(dir);
    const evidence = writeEvidence(root, assets);
    const preflight = writePreflight(root);
    const mock = writeMockGh(root);

    const result = runPromote(
      [...baseArgs(dir, preflight, evidence), ...mockArgs(mock)],
      mockEnv(mock),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "PROMOTION READY");
    assert.include(result.stdout, "SHA256SUMS");
    assert.include(result.stdout, "release create v0.0.43");
    assert.include(result.stdout, "release edit v0.0.43");
    // The fake transport must never have been invoked: a dry run makes no write.
    assert.notOk(NodeFS.existsSync(mock.log));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("blocks a candidate-only SHA that is not on fork main (simulated)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const assets = writeCandidate(dir);
    const evidence = writeEvidence(root, assets);
    const preflight = writePreflight(root, { onForkMain: false });
    const mock = writeMockGh(root);
    const result = runPromote(
      [...baseArgs(dir, preflight, evidence), ...mockArgs(mock)],
      mockEnv(mock),
    );
    assert.equal(result.status, 1);
    assert.include(result.stderr, "not an ancestor of fork/main");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("blocks an incomplete candidate before any GitHub check (simulated)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const assets = writeCandidate(dir);
    const evidence = writeEvidence(root, assets);
    const preflight = writePreflight(root);
    NodeFS.rmSync(NodePath.join(dir, INSTALLER));
    const mock = writeMockGh(root);
    const result = runPromote(
      [...baseArgs(dir, preflight, evidence), ...mockArgs(mock)],
      mockEnv(mock),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /T3-Code-0\.0\.43-x64\.exe/);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("requires candidate-specific approval to execute (simulated)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const assets = writeCandidate(dir);
    const evidence = writeEvidence(root, assets);
    const preflight = writePreflight(root);
    const mock = writeMockGh(root);
    const args = [...baseArgs(dir, preflight, evidence), ...mockArgs(mock)];

    const noApproval = runPromote([...args, "--execute"], mockEnv(mock));
    assert.equal(noApproval.status, 1);
    assert.include(noApproval.stderr, "--approve");

    const wrongApproval = runPromote(
      [...args, "--execute", "--approve", "b".repeat(64)],
      mockEnv(mock),
    );
    assert.equal(wrongApproval.status, 1);
    assert.include(wrongApproval.stderr, "does not match");

    // No approval → no draft was ever created.
    assert.notOk(NodeFS.existsSync(mock.log));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses a fixture preflight without --simulate, so it cannot drive the live publisher", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const assets = writeCandidate(dir);
    const evidence = writeEvidence(root, assets);
    const preflight = writePreflight(root);
    const liveArgs = baseArgs(dir, preflight, evidence).filter((token) => token !== "--simulate");
    const result = runPromote(liveArgs);
    assert.equal(result.status, 1);
    assert.include(result.stderr, "--simulate");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("requires a fixture and an offline transport for --simulate", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const assets = writeCandidate(dir);
    const evidence = writeEvidence(root, assets);
    const preflight = writePreflight(root);
    const base = [
      "--candidate-dir",
      dir,
      "--version",
      VERSION,
      "--sha",
      SHA,
      "--inspection-evidence",
      evidence,
    ];
    const noFixture = runPromote([...base, "--simulate"]);
    assert.equal(noFixture.status, 1);
    assert.include(noFixture.stderr, "--preflight-json");

    const noTransport = runPromote([...base, "--preflight-json", preflight, "--simulate"]);
    assert.equal(noTransport.status, 1);
    assert.include(noTransport.stderr, "offline mock transport");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("blocks an unresolved GitHub read instead of treating it as absence (simulated)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const assets = writeCandidate(dir);
    const evidence = writeEvidence(root, assets);
    const preflight = writePreflight(root, { releaseRead: "unresolved" });
    const mock = writeMockGh(root);
    const result = runPromote(
      [...baseArgs(dir, preflight, evidence), ...mockArgs(mock)],
      mockEnv(mock),
    );
    assert.equal(result.status, 1);
    assert.include(result.stderr, "could not be read from GitHub");
    assert.notOk(NodeFS.existsSync(mock.log));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("blocks publication when SHA256SUMS metadata is missing", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const assets = writeCandidate(dir);
    const evidence = writeEvidence(root, assets);
    const preflight = writePreflight(root);
    const mock = writeMockGh(root);
    NodeFS.rmSync(NodePath.join(dir, "SHA256SUMS"));
    const result = runPromote(
      [
        ...baseArgs(dir, preflight, evidence),
        ...mockArgs(mock),
        "--execute",
        "--approve",
        sha256(NodePath.join(dir, "fork-release-manifest.json")),
      ],
      mockEnv(mock),
    );
    assert.equal(result.status, 1);
    assert.include(result.stderr, "SHA256SUMS");
    assert.notOk(NodeFS.existsSync(mock.log));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("publishes a verified payload through draft → upload → readback → finalize (simulated)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const assets = writeCandidate(dir);
    const evidence = writeEvidence(root, assets);
    const preflight = writePreflight(root);
    const mock = writeMockGh(root);
    const manifestDigest = sha256(NodePath.join(dir, "fork-release-manifest.json"));

    const result = runPromote(
      [
        ...baseArgs(dir, preflight, evidence),
        ...mockArgs(mock),
        "--execute",
        "--approve",
        manifestDigest,
      ],
      mockEnv(mock),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "Published v0.0.43");

    const log = NodeFS.readFileSync(mock.log, "utf8");
    for (const verb of ['"create"', '"upload"', '"view"', '"download"', '"edit"']) {
      assert.include(log, verb);
    }
    const state = JSON.parse(
      NodeFS.readFileSync(NodePath.join(mock.state, "release.json"), "utf8"),
    ) as {
      draft: boolean;
      assets: ReadonlyArray<{ name: string }>;
    };
    assert.equal(state.draft, false);
    const publishedNames = state.assets.map((asset) => asset.name);
    assert.include(publishedNames, "SHA256SUMS");
    assert.include(publishedNames, "fork-release-manifest.json");

    // Consumer check: the uploaded SHA256SUMS validates the uploaded runtime.
    const store = NodePath.join(mock.state, "store");
    const checksums = NodeFS.readFileSync(NodePath.join(store, "SHA256SUMS"), "utf8");
    const expectedDigest = sha256(NodePath.join(store, RUNTIME));
    assert.match(
      checksums,
      new RegExp(`${expectedDigest}\\s+\\*?${RUNTIME.replace(/\./g, "\\.")}`),
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("does not finalize when a downloaded byte changed (simulated)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const assets = writeCandidate(dir);
    const evidence = writeEvidence(root, assets);
    const preflight = writePreflight(root);
    const mock = writeMockGh(root);
    const manifestDigest = sha256(NodePath.join(dir, "fork-release-manifest.json"));

    const result = runPromote(
      [
        ...baseArgs(dir, preflight, evidence),
        ...mockArgs(mock),
        "--execute",
        "--approve",
        manifestDigest,
      ],
      mockEnv(mock, { GH_MOCK_CORRUPT: RUNTIME }),
    );
    assert.equal(result.status, 1);
    assert.notInclude(result.stdout, "Published");
    assert.include(result.stderr, "sha256");
    assert.notInclude(NodeFS.readFileSync(mock.log, "utf8"), '"edit"');
    const state = JSON.parse(
      NodeFS.readFileSync(NodePath.join(mock.state, "release.json"), "utf8"),
    ) as {
      draft: boolean;
    };
    assert.equal(state.draft, true);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("does not finalize on a partial upload / missing readback asset (simulated)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const assets = writeCandidate(dir);
    const evidence = writeEvidence(root, assets);
    const preflight = writePreflight(root);
    const mock = writeMockGh(root);
    const manifestDigest = sha256(NodePath.join(dir, "fork-release-manifest.json"));

    const result = runPromote(
      [
        ...baseArgs(dir, preflight, evidence),
        ...mockArgs(mock),
        "--execute",
        "--approve",
        manifestDigest,
      ],
      mockEnv(mock, { GH_MOCK_OMIT: INSTALLER }),
    );
    assert.equal(result.status, 1);
    assert.include(result.stderr, `uploaded asset ${INSTALLER} is missing`);
    assert.notInclude(NodeFS.readFileSync(mock.log, "utf8"), '"edit"');
    assert.notInclude(result.stdout, "Published");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("does not print success when the upload command fails (simulated)", () => {
  const root = scratch();
  try {
    const dir = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(dir);
    const assets = writeCandidate(dir);
    const evidence = writeEvidence(root, assets);
    const preflight = writePreflight(root);
    const mock = writeMockGh(root);
    const manifestDigest = sha256(NodePath.join(dir, "fork-release-manifest.json"));

    const result = runPromote(
      [
        ...baseArgs(dir, preflight, evidence),
        ...mockArgs(mock),
        "--execute",
        "--approve",
        manifestDigest,
      ],
      mockEnv(mock, { GH_MOCK_FAIL_UPLOAD: "1" }),
    );
    assert.equal(result.status, 1);
    assert.notInclude(result.stdout, "Published");
    assert.notInclude(NodeFS.readFileSync(mock.log, "utf8"), '"edit"');
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
