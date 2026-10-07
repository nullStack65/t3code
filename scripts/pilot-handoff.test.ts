// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Exercises the documented shell guard and measurement recipe against the real installer and local fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// The documented handoff is the source of truth: these tests extract and run
// the exact shell blocks an operator would copy, so the guide cannot drift from
// the verified behavior.
const docPath = NodePath.resolve(import.meta.dirname, "../docs/user/linux-opencode-pilot.md");
const installerPath = NodePath.resolve(import.meta.dirname, "install.sh");
const version = "9.9.9-test";
const archiveName = `t3-${version}-linux-x64.tar.gz`;

function extractShBlocks(doc: string): Array<string> {
  const lines = doc.split("\n");
  const blocks: Array<string> = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]?.trim() !== "```sh") continue;
    const body: Array<string> = [];
    index++;
    while (index < lines.length && lines[index]?.trim() !== "```") {
      body.push(lines[index] ?? "");
      index++;
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

function sha256(bytes: Buffer | string): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function runSh(
  script: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("sh", ["-c", script], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function listen(server: NodeHttp.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return address.port;
}

async function close(server: NodeHttp.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function makeArchive(root: string, label: string): Promise<string> {
  const stem = `t3-${version}-linux-x64`;
  const build = NodePath.join(root, `build-${label}`);
  await NodeFSP.mkdir(NodePath.join(build, stem), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(build, stem, "t3"), `#!/bin/sh\necho ${label}\n`, {
    mode: 0o755,
  });
  await NodeFSP.writeFile(NodePath.join(build, stem, "payload"), NodeCrypto.randomBytes(2048));
  const archive = NodePath.join(root, `${label}.tar.gz`);
  NodeChildProcess.execFileSync("tar", ["-czf", archive, "-C", build, stem]);
  return archive;
}

type Fixture = {
  root: string;
  guard: string;
  measure: string;
  shimDir: string;
  installerSha: string;
  archiveA: string;
  archiveABytes: Buffer;
  archiveASha: string;
  archiveASize: number;
  archiveB: string;
  archiveBBytes: Buffer;
  archiveBSha: string;
  env: (home: string, bin: string, extra: Record<string, string>) => NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
};

async function makeFixture(): Promise<Fixture> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pilot-handoff-"));
  const doc = await NodeFSP.readFile(docPath, "utf8");
  const blocks = extractShBlocks(doc);
  if (blocks.length < 2)
    throw new Error(`expected >=2 sh blocks in ${docPath}, got ${blocks.length}`);
  const [guard, measure] = blocks as [string, string];

  const shimDir = NodePath.join(root, "shim");
  await NodeFSP.mkdir(shimDir, { recursive: true });
  const unameShim = [
    "#!/bin/sh",
    'case "${1:-}" in',
    "  -s) echo Linux ;;",
    "  -m) echo x86_64 ;;",
    '  *) exec /usr/bin/uname "$@" ;;',
    "esac",
    "",
  ].join("\n");
  await NodeFSP.writeFile(NodePath.join(shimDir, "uname"), unameShim, { mode: 0o755 });

  const installerBytes = await NodeFSP.readFile(installerPath);
  const archiveA = await makeArchive(root, "A");
  const archiveB = await makeArchive(root, "B");
  const archiveABytes = await NodeFSP.readFile(archiveA);
  const archiveBBytes = await NodeFSP.readFile(archiveB);
  const archiveASha = sha256(archiveABytes);
  const archiveBSha = sha256(archiveBBytes);
  const archiveASize = (await NodeFSP.stat(archiveA)).size;

  const env = (home: string, bin: string, extra: Record<string, string>): NodeJS.ProcessEnv => ({
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    T3CODE_HOME: home,
    T3CODE_INSTALL_BIN_DIR: bin,
    T3_INSTALLER_SHA256: sha256(installerBytes),
    T3_INSTALLER_SOURCE_URL: `file://${installerPath}`,
    T3_ARCHIVE_SOURCE_URL: `file://${archiveA}`,
    T3_VERSION: version,
    T3_ARCHIVE_SHA256: archiveASha,
    T3_ARCHIVE_SIZE: String(archiveASize),
    T3_BINARY_SOURCE: "a".repeat(40),
    OPENCODE_VERSION: "1.17.9",
    OPENCODE_LINUX_SHA256: "b".repeat(64),
    ...extra,
  });

  return {
    root,
    guard,
    measure,
    shimDir,
    installerSha: sha256(installerBytes),
    archiveA,
    archiveABytes,
    archiveASha,
    archiveASize,
    archiveB,
    archiveBBytes,
    archiveBSha,
    env,
    cleanup: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

function startsWith(text: string, prefix: string): boolean {
  return text.startsWith(prefix);
}

describe("linux OpenCode pilot handoff", () => {
  it("documents exactly the installer guard and measurement recipe under test", async () => {
    const doc = await NodeFSP.readFile(docPath, "utf8");
    const blocks = extractShBlocks(doc);
    expect(blocks.length).toBe(2);
    expect(doc).toContain('T3CODE_RELEASE_BASE_URL="http://127.0.0.1:${port}"');
  });

  it("drives the real installer at the pinned commit digest", async () => {
    const bytes = await NodeFSP.readFile(installerPath);
    expect(sha256(bytes)).toBe("e2462ba995aaa2773872f1fe9f2ccee53094d4ba6a4207dbc5115a65710b8a0a");
    expect(bytes.length).toBe(9838);
  });

  it("refuses an unset/UNISSUED receipt before any mutation", async () => {
    const fixture = await makeFixture();
    try {
      const home = NodePath.join(fixture.root, "home-unissued");
      const bin = NodePath.join(fixture.root, "bin-unissued");
      const env = fixture.env(home, bin, {
        T3_ARCHIVE_SHA256: "UNISSUED",
        T3_ARCHIVE_SIZE: "UNISSUED",
        T3_BINARY_SOURCE: "UNISSUED",
        OPENCODE_VERSION: "UNISSUED",
        OPENCODE_LINUX_SHA256: "UNISSUED",
      });
      delete env.T3_VERSION;
      const result = await runSh(fixture.guard, env);
      expect(result.code).toBe(78);
      expect(result.stderr).toContain("unset/UNISSUED");
      await expect(NodeFSP.stat(NodePath.join(home, "runtime"))).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a malformed receipt before any mutation", async () => {
    const fixture = await makeFixture();
    try {
      const home = NodePath.join(fixture.root, "home-malformed");
      const result = await runSh(
        fixture.guard,
        fixture.env(home, NodePath.join(fixture.root, "bin-malformed"), {
          T3_ARCHIVE_SHA256: "not-a-digest",
        }),
      );
      expect(result.code).toBe(65);
      expect(result.stderr).toContain("not a 64-hex digest");
      await expect(NodeFSP.stat(NodePath.join(home, "runtime"))).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });

  it("stops when the pinned installer digest does not match", async () => {
    const fixture = await makeFixture();
    try {
      const home = NodePath.join(fixture.root, "home-installer-mismatch");
      const result = await runSh(
        fixture.guard,
        fixture.env(home, NodePath.join(fixture.root, "bin-a"), {
          T3_INSTALLER_SHA256: "0".repeat(64),
        }),
      );
      expect(result.code).toBe(65);
      expect(result.stderr).toContain("installer digest mismatch");
      await expect(NodeFSP.stat(NodePath.join(home, "runtime"))).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });

  it("stops on an archive size mismatch before the installer can extract", async () => {
    const fixture = await makeFixture();
    try {
      const home = NodePath.join(fixture.root, "home-size-mismatch");
      const result = await runSh(
        fixture.guard,
        fixture.env(home, NodePath.join(fixture.root, "bin-b"), {
          T3_ARCHIVE_SIZE: String(fixture.archiveASize + 1),
        }),
      );
      expect(result.code).toBe(65);
      expect(result.stderr).toContain("archive size mismatch");
      await expect(NodeFSP.stat(NodePath.join(home, "runtime"))).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });

  it("stops on an archive digest mismatch before the installer can extract", async () => {
    const fixture = await makeFixture();
    try {
      const home = NodePath.join(fixture.root, "home-hash-mismatch");
      const result = await runSh(
        fixture.guard,
        fixture.env(home, NodePath.join(fixture.root, "bin-c"), {
          T3_ARCHIVE_SHA256: "0".repeat(64),
        }),
      );
      expect(result.code).toBe(65);
      expect(result.stderr).toContain("archive digest mismatch");
      await expect(NodeFSP.stat(NodePath.join(home, "runtime"))).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not let a stale install marker skip consumption of verified bytes", async () => {
    const fixture = await makeFixture();
    try {
      const home = NodePath.join(fixture.root, "home-marker");
      const target = NodePath.join(home, "runtime", "versions", version);
      await NodeFSP.mkdir(target, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), `${version}\n`);
      const result = await runSh(
        fixture.guard,
        fixture.env(home, NodePath.join(fixture.root, "bin-marker"), {}),
      );
      expect(result.code).toBe(65);
      expect(result.stderr).toContain("install marker");
    } finally {
      await fixture.cleanup();
    }
  });

  it("consumes archive A even when an ambient release-base override serves B", async () => {
    const fixture = await makeFixture();
    let evilRequests = 0;
    const evil = NodeHttp.createServer((request, response) => {
      evilRequests++;
      if (request.url?.endsWith("SHA256SUMS")) {
        response.end(`${fixture.archiveBSha}  ${archiveName}\n`);
      } else {
        response.writeHead(200, { "Content-Length": fixture.archiveBBytes.length });
        response.end(fixture.archiveBBytes);
      }
    });
    try {
      const evilPort = await listen(evil);
      const home = NodePath.join(fixture.root, "home-ambient");
      const bin = NodePath.join(fixture.root, "bin-ambient");
      const result = await runSh(
        fixture.guard,
        fixture.env(home, bin, { T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${evilPort}` }),
      );
      expect(result.stderr).not.toContain("refusing");
      expect(result.code).toBe(0);
      expect(evilRequests).toBe(0);
      const installed = NodeChildProcess.execFileSync(NodePath.join(bin, "t3"), ["--version"], {
        encoding: "utf8",
      }).trim();
      expect(installed).toBe("A");
    } finally {
      await close(evil);
      await fixture.cleanup();
    }
  });

  it("does not re-download a substituted archive after the precheck", async () => {
    const fixture = await makeFixture();
    let archiveRequests = 0;
    const flip = NodeHttp.createServer((request, response) => {
      if (request.url?.endsWith(".tar.gz")) {
        archiveRequests++;
        const body = archiveRequests === 1 ? fixture.archiveABytes : fixture.archiveBBytes;
        response.writeHead(200, { "Content-Length": body.length });
        response.end(body);
      } else {
        response.writeHead(404).end();
      }
    });
    try {
      const flipPort = await listen(flip);
      const home = NodePath.join(fixture.root, "home-flip");
      const bin = NodePath.join(fixture.root, "bin-flip");
      const result = await runSh(
        fixture.guard,
        fixture.env(home, bin, {
          T3_ARCHIVE_SOURCE_URL: `http://127.0.0.1:${flipPort}/${archiveName}`,
        }),
      );
      expect(result.code).toBe(0);
      expect(archiveRequests).toBe(1);
      const installed = NodeChildProcess.execFileSync(NodePath.join(bin, "t3"), ["--version"], {
        encoding: "utf8",
      }).trim();
      expect(installed).toBe("A");
      expect(
        await NodeFSP.readFile(
          NodePath.join(home, "runtime", "versions", version, ".install-complete"),
          "utf8",
        ),
      ).toBe(`${version}\n`);
    } finally {
      await close(flip);
      await fixture.cleanup();
    }
  });

  it("performs a successful isolated dormant install of the approved fixture", async () => {
    const fixture = await makeFixture();
    try {
      const home = NodePath.join(fixture.root, "home-ok");
      const bin = NodePath.join(fixture.root, "bin-ok");
      const result = await runSh(fixture.guard, fixture.env(home, bin, {}));
      expect(result.stderr).not.toContain("refusing");
      expect(result.code).toBe(0);
      expect(result.stderr).toContain(`Installed T3 Code ${version}`);
      const installed = NodeChildProcess.execFileSync(NodePath.join(bin, "t3"), ["--version"], {
        encoding: "utf8",
      }).trim();
      expect(installed).toBe("A");
      const targetDir = NodePath.join(home, "runtime", "versions", version);
      const entries = await NodeFSP.readdir(targetDir);
      expect(entries).not.toContain(archiveName);
      expect(entries).not.toContain("SHA256SUMS");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("bounded measurement recipe", () => {
  async function makeClock(root: string, start = 0): Promise<string> {
    const clock = NodePath.join(root, "clock");
    await NodeFSP.writeFile(clock, String(start));
    const script = NodePath.join(root, "clock.sh");
    const body = [
      "#!/bin/sh",
      'f="$CLOCK"',
      'c="$(cat "$f" 2>/dev/null || echo 0)"',
      'echo $((c+1)) > "$f"',
      'echo "$c"',
      "",
    ].join("\n");
    await NodeFSP.writeFile(script, body, { mode: 0o755 });
    return script;
  }

  it("stops immediately for a zero-duration window without writing or overrunning", async () => {
    const fixture = await makeFixture();
    try {
      const root = NodePath.join(fixture.root, "measure-zero");
      await NodeFSP.mkdir(root, { recursive: true });
      const clock = await makeClock(root);
      const out = NodePath.join(root, "out");
      const result = await runSh(fixture.measure, {
        ...process.env,
        CLOCK: NodePath.join(root, "clock"),
        MEASURE_NOW: clock,
        MEASURE_SLEEP: "true",
        MEASURE_MAX_SECONDS: "0",
        MEASURE_PROBE: "echo sample",
        MEASURE_OUT: out,
      });
      expect(result.code).toBe(0);
      const log = NodePath.join(out, "monitor.log");
      const exists = await NodeFSP.stat(log).then(
        () => true,
        () => false,
      );
      expect(exists ? (await NodeFSP.readFile(log, "utf8")).length : 0).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("writes nothing when the remaining byte budget cannot fit one line", async () => {
    const fixture = await makeFixture();
    try {
      const root = NodePath.join(fixture.root, "measure-cap");
      await NodeFSP.mkdir(root, { recursive: true });
      const clock = await makeClock(root);
      const out = NodePath.join(root, "out");
      const result = await runSh(fixture.measure, {
        ...process.env,
        CLOCK: NodePath.join(root, "clock"),
        MEASURE_NOW: clock,
        MEASURE_SLEEP: "true",
        MEASURE_MAX_SECONDS: "1000",
        MEASURE_CAP_BYTES: "1",
        MEASURE_PROBE: "echo hello",
        MEASURE_OUT: out,
      });
      expect(result.code).toBe(0);
      const log = NodePath.join(out, "monitor.log");
      const exists = await NodeFSP.stat(log).then(
        () => true,
        () => false,
      );
      expect(exists ? (await NodeFSP.readFile(log, "utf8")).length : 0).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("bounds a stalled probe and records the sample as unavailable", async () => {
    const fixture = await makeFixture();
    try {
      const root = NodePath.join(fixture.root, "measure-stall");
      await NodeFSP.mkdir(root, { recursive: true });
      const clock = await makeClock(root);
      const out = NodePath.join(root, "out");
      const probePidFile = NodePath.join(root, "probe.pid");
      let probePid: number | undefined;
      const started = Date.now();
      try {
        const result = await runSh(fixture.measure, {
          ...process.env,
          CLOCK: NodePath.join(root, "clock"),
          MEASURE_NOW: clock,
          MEASURE_SLEEP: "true",
          MEASURE_MAX_SECONDS: "2",
          MEASURE_PROBE_TIMEOUT: "1",
          MEASURE_PROBE: 'sleep 30 & echo "$!" > "$PROBE_PID_FILE"; wait',
          PROBE_PID_FILE: probePidFile,
          MEASURE_OUT: out,
        });
        const elapsed = Date.now() - started;
        expect(result.code).toBe(0);
        expect(elapsed).toBeLessThan(10_000);
        probePid = Number(await NodeFSP.readFile(probePidFile, "utf8"));
        expect(Number.isInteger(probePid) && probePid > 1).toBe(true);

        let probeExited = false;
        for (let attempt = 0; attempt < 40; attempt++) {
          const stat = await NodeFSP.readFile(`/proc/${probePid}/stat`, "utf8").catch(() => "");
          const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
          if (!stat || state === "Z" || state === "X") {
            probeExited = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(probeExited).toBe(true);
        const log = await NodeFSP.readFile(NodePath.join(out, "monitor.log"), "utf8");
        expect(log).toContain("unavailable");
      } finally {
        const pidToStop =
          probePid ?? Number(await NodeFSP.readFile(probePidFile, "utf8").catch(() => ""));
        if (Number.isInteger(pidToStop) && pidToStop > 1) {
          try {
            process.kill(pidToStop, "SIGKILL");
          } catch {
            // The timeout already terminated the exact probe PID.
          }
        }
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps cumulative output under the cap across several samples", async () => {
    const fixture = await makeFixture();
    try {
      const root = NodePath.join(fixture.root, "measure-ok");
      await NodeFSP.mkdir(root, { recursive: true });
      const clock = await makeClock(root);
      const out = NodePath.join(root, "out");
      const cap = 4096;
      const result = await runSh(fixture.measure, {
        ...process.env,
        CLOCK: NodePath.join(root, "clock"),
        MEASURE_NOW: clock,
        MEASURE_SLEEP: "true",
        MEASURE_MAX_SECONDS: "5",
        MEASURE_INTERVAL: "1",
        MEASURE_CAP_BYTES: String(cap),
        MEASURE_PROBE: "echo sample",
        MEASURE_OUT: out,
      });
      expect(result.code).toBe(0);
      const log = await NodeFSP.readFile(NodePath.join(out, "monitor.log"), "utf8");
      const lines = log.split("\n").filter((lineValue) => lineValue.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(Buffer.byteLength(log, "utf8")).toBeLessThanOrEqual(cap);
      expect(startsWith(lines[0] ?? "", "sample")).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
