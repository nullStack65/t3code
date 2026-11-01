import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  candidateResourceMonitorStaging,
  planCandidateBuild,
  planCandidateStaging,
  planCandidateTargetVerification,
  planCandidateVerification,
  stageCandidateResourceMonitor,
  type CandidatePlanStep,
} from "./candidate-build-plan.ts";

const flat = (steps: ReadonlyArray<CandidatePlanStep>): string =>
  steps.map((step) => step.command.join(" ")).join("\n");

const VERSION = "0.0.43";
const SHA = "bcc1a58b19a9d610a4f08fed191a364767bc65b3";

it("plans the Linux runtime archive with the workflow's own scripts and the requested version", () => {
  const steps = planCandidateBuild({
    target: "linux",
    version: VERSION,
    outputDir: "candidate",
    resourceMonitorDir: "/tmp/rm",
  });
  const commands = flat(steps);
  assert.include(commands, "scripts/update-release-package-versions.ts");
  assert.include(commands, "scripts/build-cli-archive.ts");
  assert.include(commands, "scripts/smoke-cli-archive.ts");
  assert.include(commands, "apps/server/scripts/cli.ts build-exe");
  assert.include(commands, `--version ${VERSION}`);
  assert.include(commands, "--resource-monitor-dir /tmp/rm");
  assert.include(commands, "--output-dir candidate");
});

it("plans the Windows installer, the Windows CLI ZIP, and the WSL runtime", () => {
  const steps = planCandidateBuild({
    target: "win",
    version: VERSION,
    outputDir: "candidate",
    resourceMonitorDir: "/tmp/rm",
    linuxArchive: `candidate/t3-${VERSION}-linux-x64.tar.gz`,
  });
  const commands = flat(steps);
  assert.include(commands, "scripts/build-desktop-artifact.ts");
  assert.include(commands, "--platform win");
  assert.include(commands, "--target nsis");
  assert.include(commands, `--build-version ${VERSION}`);
  assert.include(commands, `--output-dir candidate`);
  assert.include(commands, `--wsl-runtime candidate/t3-${VERSION}-linux-x64.tar.gz`);
  // The Windows CLI ZIP the install/update path now requires.
  assert.include(commands, "--platform win");
  assert.include(commands, `t3-${VERSION}-win32-x64.zip`);
  assert.include(commands, "x86_64-pc-windows-msvc");
});

it("refuses a Windows plan without the Linux runtime archive", () => {
  assert.throws(() =>
    planCandidateBuild({
      target: "win",
      version: VERSION,
      outputDir: "candidate",
      resourceMonitorDir: "/tmp/rm",
    }),
  );
});

it("plans the Intel macOS DMG with the requested version and output directory", () => {
  const steps = planCandidateBuild({
    target: "mac",
    version: VERSION,
    outputDir: "candidate dir",
    resourceMonitorDir: "/tmp/rm",
  });
  const commands = flat(steps);
  assert.include(commands, "--platform mac");
  assert.include(commands, "--target dmg");
  assert.include(commands, "--arch x64");
  assert.include(commands, `--build-version ${VERSION}`);
  assert.include(commands, `--output-dir candidate dir`);
});

it("per-target verification binds only that target and never requires other platforms", () => {
  const step = planCandidateTargetVerification({
    target: "linux",
    version: VERSION,
    sourceSha: SHA,
    repository: "nullStack65/t3code",
    candidateDir: "candidate",
  });
  const command = step.command.join(" ");
  assert.include(command, "scripts/verify-fork-candidate.ts");
  assert.include(command, "--targets linux");
  assert.notInclude(command, "--write-manifest");
  // A single-platform verify must not demand the complete asset set.
  assert.notInclude(command, "--require-native-receipts");
});

it("stages each target artifact into the shared candidate directory", () => {
  const steps = planCandidateStaging({ target: "win", version: VERSION, outputDir: "out dir" });
  const commands = flat(steps);
  assert.include(commands, `T3-Code-${VERSION}-x64.exe`);
  assert.include(commands, `t3-${VERSION}-win32-x64.zip`);
  assert.include(commands, "--output-dir out dir");
});

it("does not demand the optional Apple Silicon DMG for an Intel-only mac build", () => {
  const intel = flat(
    planCandidateStaging({ target: "mac", version: VERSION, outputDir: "candidate" }),
  );
  assert.include(intel, `T3-Code-${VERSION}-x64.dmg`);
  assert.notInclude(intel, `T3-Code-${VERSION}-arm64.dmg`);

  const withArm = flat(
    planCandidateStaging({
      target: "mac",
      version: VERSION,
      outputDir: "candidate",
      includeMacosArm64: true,
    }),
  );
  assert.include(withArm, `T3-Code-${VERSION}-arm64.dmg`);
});

it("uses the shared aggregate verifier so local and CI candidates are frozen identically", () => {
  const step = planCandidateVerification({
    version: VERSION,
    sourceSha: SHA,
    repository: "nullStack65/t3code",
    candidateDir: "candidate",
  });
  const command = step.command.join(" ");
  assert.equal(step.phase, "aggregate");
  assert.include(command, "scripts/verify-fork-candidate.ts");
  assert.include(command, `--sha ${SHA}`);
  assert.include(command, "--write-checksums");
  // Native receipts are a promotion gate, not a build-time requirement.
  assert.notInclude(command, "--require-native-receipts");
});

it("emits and consumes digest-bound inspection evidence through the local route", () => {
  const verify = planCandidateTargetVerification({
    target: "win",
    version: VERSION,
    sourceSha: SHA,
    repository: "nullStack65/t3code",
    candidateDir: "candidate",
    emitInspection: "candidate/fork-inspection-evidence-win.json",
  });
  assert.include(
    verify.command.join(" "),
    "--emit-inspection candidate/fork-inspection-evidence-win.json",
  );

  const aggregate = planCandidateVerification({
    version: VERSION,
    sourceSha: SHA,
    repository: "nullStack65/t3code",
    candidateDir: "candidate",
    inspectionEvidence: [
      "candidate/fork-inspection-evidence-win.json",
      "candidate/fork-inspection-evidence-mac.json",
    ],
  });
  assert.include(
    aggregate.command.join(" "),
    "--inspection-evidence candidate/fork-inspection-evidence-win.json,candidate/fork-inspection-evidence-mac.json",
  );
});

function withTempDir(run: (dir: string) => void): void {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-rm-stage-"));
  try {
    run(dir);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

it("stages the Windows MSVC helper into the directory the CLI archive consumes (real files)", () => {
  withTempDir((root) => {
    const repoRoot = NodePath.join(root, "repo");
    const source = NodePath.join(
      repoRoot,
      candidateResourceMonitorStaging("win").sourceRelativePath,
    );
    NodeFS.mkdirSync(NodePath.dirname(source), { recursive: true });
    const bytes = Buffer.from("MSVC t3-resource-monitor fixture\n");
    NodeFS.writeFileSync(source, bytes);

    // A clean staging directory whose path also contains spaces.
    const stagingDir = NodePath.join(root, "clean staging dir");
    const staged = stageCandidateResourceMonitor({
      target: "win",
      resourceMonitorDir: stagingDir,
      repoRoot,
    });

    assert.equal(staged, NodePath.join(stagingDir, "win32-x64", "t3-resource-monitor.exe"));
    assert.deepEqual(NodeFS.readFileSync(staged), bytes);

    // The Windows CLI archive consumes exactly the directory that was staged.
    const plan = planCandidateBuild({
      target: "win",
      version: VERSION,
      outputDir: "candidate",
      resourceMonitorDir: stagingDir,
      linuxArchive: `candidate/t3-${VERSION}-linux-x64.tar.gz`,
    });
    const archive = plan.find((step) => step.id === "cli-archive")!;
    const flag = archive.command.indexOf("--resource-monitor-dir");
    assert.equal(archive.command[flag + 1], stagingDir);
  });
});

it("fails closed when the Windows MSVC build output is missing and never reuses a stale helper (real files)", () => {
  withTempDir((root) => {
    const repoRoot = NodePath.join(root, "repo");
    const stagingDir = NodePath.join(root, "out");
    const destination = NodePath.join(stagingDir, "win32-x64", "t3-resource-monitor.exe");
    NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
    NodeFS.writeFileSync(destination, "stale GNU helper");

    assert.throws(
      () => stageCandidateResourceMonitor({ target: "win", resourceMonitorDir: stagingDir, repoRoot }),
      /build output is missing/,
    );
    // The stale helper is untouched, but it was never accepted as staged output.
    assert.equal(NodeFS.readFileSync(destination, "utf8"), "stale GNU helper");
  });
});

it("resolves the correct native helper layout per target and rejects the CLI-less mac target", () => {
  assert.equal(
    candidateResourceMonitorStaging("linux").destinationRelativePath,
    "linux-x64/t3-resource-monitor",
  );
  assert.equal(
    candidateResourceMonitorStaging("win").destinationRelativePath,
    "win32-x64/t3-resource-monitor.exe",
  );
  assert.throws(() => candidateResourceMonitorStaging("mac"), /ships no t3 CLI archive/);
});

