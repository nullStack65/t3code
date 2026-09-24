import { assert, it } from "@effect/vitest";

import {
  planCandidateBuild,
  planCandidateStaging,
  planCandidateTargetVerification,
  planCandidateVerification,
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
