import { assert, it } from "@effect/vitest";

import {
  planCandidateBuild,
  planCandidateVerification,
  type CandidatePlanStep,
} from "./candidate-build-plan.ts";

const flat = (steps: ReadonlyArray<CandidatePlanStep>): string =>
  steps.map((step) => step.command.join(" ")).join("\n");

const VERSION = "0.0.43";
const SHA = "bcc1a58b19a9d610a4f08fed191a364767bc65b3";

it("plans the Linux runtime archive with the workflow's own scripts", () => {
  const steps = planCandidateBuild({
    target: "linux",
    version: VERSION,
    outputDir: "candidate",
    resourceMonitorDir: "/tmp/rm",
  });
  const commands = flat(steps);
  assert.include(commands, "scripts/build-cli-archive.ts");
  assert.include(commands, "scripts/smoke-cli-archive.ts");
  assert.include(commands, "apps/server/scripts/cli.ts build-exe");
  assert.include(commands, `--version ${VERSION}`);
  assert.include(commands, "--resource-monitor-dir /tmp/rm");
});

it("plans the Windows installer with the Linux WSL runtime embedded", () => {
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
  assert.include(commands, `--wsl-runtime candidate/t3-${VERSION}-linux-x64.tar.gz`);
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

it("plans the Intel macOS DMG", () => {
  const steps = planCandidateBuild({
    target: "mac",
    version: VERSION,
    outputDir: "candidate",
    resourceMonitorDir: "/tmp/rm",
  });
  const commands = flat(steps);
  assert.include(commands, "--platform mac");
  assert.include(commands, "--target dmg");
  assert.include(commands, "--arch x64");
});

it("uses the shared verifier so local and CI candidates are checked identically", () => {
  const step = planCandidateVerification({
    version: VERSION,
    sourceSha: SHA,
    repository: "nullStack65/t3code",
    candidateDir: "candidate",
  });
  const command = step.command.join(" ");
  assert.include(command, "scripts/verify-fork-candidate.ts");
  assert.include(command, `--sha ${SHA}`);
  assert.include(command, "--write-checksums");
  // Native receipts are a promotion gate, not a build-time requirement.
  assert.notInclude(command, "--require-native-receipts");
});
