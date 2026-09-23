#!/usr/bin/env node
/**
 * Machine-local fork release candidate build plan.
 *
 * CI capacity is a separate provisioning gate. When an authorized GitHub
 * Actions runner is unavailable, the already-authorized Windows/WSL and Intel
 * macOS sessions assemble the candidate with the *same* scripts the workflow
 * uses (`build-cli-archive.ts`, `build-desktop-artifact.ts`,
 * `smoke-cli-archive.ts`) and the same verifier
 * (`verify-fork-candidate.ts`). This module is the shared plan so the two
 * routes cannot drift.
 */

export type CandidateTarget = "linux" | "win" | "mac";

export interface CandidatePlanStep {
  readonly id: string;
  readonly description: string;
  readonly command: ReadonlyArray<string>;
}

export interface CandidatePlanInput {
  readonly target: CandidateTarget;
  readonly version: string;
  readonly outputDir: string;
  /** Directory holding `<resource_key>/t3-resource-monitor[.exe]` for the archive. */
  readonly resourceMonitorDir: string;
  /** Path to the Linux x64 archive embedded as the Windows WSL runtime. */
  readonly linuxArchive?: string | undefined;
}

export interface VerificationPlanInput {
  readonly version: string;
  readonly sourceSha: string;
  readonly repository: string;
  readonly candidateDir: string;
  readonly includeMacosArm64?: boolean;
}

/** The steps that build one target's artifacts into `outputDir`. */
export function planCandidateBuild(input: CandidatePlanInput): ReadonlyArray<CandidatePlanStep> {
  if (input.target === "linux") {
    return [
      {
        id: "install",
        description: "Install workspace dependencies",
        command: ["vp", "install"],
      },
      {
        id: "bundle",
        description: "Build the server/web bundle",
        command: ["vp", "run", "--filter", "t3", "build"],
      },
      {
        id: "resource-monitor",
        description: "Build the Linux resource monitor from source",
        command: [
          "cargo",
          "build",
          "--locked",
          "--release",
          "--manifest-path",
          "native/resource-monitor/Cargo.toml",
        ],
      },
      {
        id: "sea",
        description: "Build the Linux single-executable",
        command: ["node", "apps/server/scripts/cli.ts", "build-exe", "--verbose"],
      },
      {
        id: "archive",
        description: "Assemble the Linux x64 runtime archive",
        command: [
          "node",
          "scripts/build-cli-archive.ts",
          "--platform",
          "linux",
          "--arch",
          "x64",
          "--version",
          input.version,
          "--resource-monitor-dir",
          input.resourceMonitorDir,
          "--output-dir",
          input.outputDir,
        ],
      },
      {
        id: "smoke",
        description: "Smoke-test the Linux archive with no ambient Node",
        command: [
          "node",
          "scripts/smoke-cli-archive.ts",
          "--archive",
          `${input.outputDir}/t3-${input.version}-linux-x64.tar.gz`,
          "--expect-version",
          input.version,
        ],
      },
    ];
  }

  if (input.target === "win") {
    if (input.linuxArchive === undefined || input.linuxArchive.trim() === "") {
      throw new Error(
        "the Windows desktop embeds the Linux x64 runtime; pass --linux-archive <t3-<version>-linux-x64.tar.gz>",
      );
    }
    return [
      {
        id: "install",
        description: "Install workspace dependencies",
        command: ["vp", "install"],
      },
      {
        id: "desktop",
        description: "Package the Windows x64 NSIS installer with the Linux WSL runtime",
        command: [
          "node",
          "scripts/build-desktop-artifact.ts",
          "--platform",
          "win",
          "--target",
          "nsis",
          "--arch",
          "x64",
          "--wsl-runtime",
          input.linuxArchive,
          "--verbose",
        ],
      },
    ];
  }

  return [
    {
      id: "install",
      description: "Install workspace dependencies",
      command: ["vp", "install"],
    },
    {
      id: "desktop",
      description: "Package the Intel macOS x64 DMG (unsigned unless Apple secrets exist)",
      command: [
        "node",
        "scripts/build-desktop-artifact.ts",
        "--platform",
        "mac",
        "--target",
        "dmg",
        "--arch",
        "x64",
        "--verbose",
      ],
    },
  ];
}

/** The verification step every candidate must pass before it is publishable. */
export function planCandidateVerification(input: VerificationPlanInput): CandidatePlanStep {
  const command = [
    "node",
    "scripts/verify-fork-candidate.ts",
    "--candidate-dir",
    input.candidateDir,
    "--version",
    input.version,
    "--sha",
    input.sourceSha,
    "--repository",
    input.repository,
    "--write-manifest",
    "--write-checksums",
  ];
  if (input.includeMacosArm64 === true) {
    command.push("--include-macos-arm64");
  }
  return {
    id: "verify",
    description: "Freeze the manifest/checksums and verify the candidate bytes",
    command,
  };
}
