#!/usr/bin/env node
/**
 * Machine-local fork release candidate build plan.
 *
 * CI capacity is a separate provisioning gate. When an authorized GitHub
 * Actions runner is unavailable, the already-authorized Windows/WSL and Intel
 * macOS sessions assemble the candidate with the *same* scripts the workflow
 * uses (`build-cli-archive.ts`, `build-desktop-artifact.ts`,
 * `smoke-cli-archive.ts`) and the same verifier (`verify-fork-candidate.ts`).
 * This module is the shared plan so the two routes cannot drift.
 *
 * The plan is deliberately two-phase:
 *
 *   1. Per target: build/stage/verify *one* platform's outputs into the shared
 *      candidate directory. This phase never requires any other platform.
 *   2. Aggregate: gather the native outputs (documented transfer procedure),
 *      then verify and freeze the complete candidate.
 *
 * A Linux-only build must be able to succeed and produce a durable partial
 * candidate before a macOS or Windows artifact exists. The aggregate step still
 * requires the complete required artifact set; it is never weakened to make a
 * partial build look complete.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type CandidateTarget = "linux" | "win" | "mac";

export interface CandidatePlanStep {
  readonly id: string;
  readonly description: string;
  readonly command: ReadonlyArray<string>;
  /**
   * `build` steps produce artifacts. `stage` steps copy a platform's outputs
   * into the shared candidate directory. `verify` steps check one platform's
   * bytes. `aggregate` freezes the whole candidate.
   */
  readonly phase: "install" | "build" | "stage" | "verify" | "aggregate";
}

export interface CandidatePlanInput {
  readonly target: CandidateTarget;
  readonly version: string;
  readonly outputDir: string;
  /** Directory holding `<resource_key>/t3-resource-monitor[.exe]` for the archive. */
  readonly resourceMonitorDir: string;
  /** Path to the Linux x64 archive embedded as the Windows WSL runtime. */
  readonly linuxArchive?: string | undefined;
  /**
   * Absolute path to the workspace checkout whose dependencies are already
   * installed. When omitted the plan runs `vp install` first.
   */
  readonly assumeInstalled?: boolean | undefined;
  /** Build and stage the optional Apple Silicon DMG too. */
  readonly includeMacosArm64?: boolean | undefined;
}

export interface VerificationPlanInput {
  readonly version: string;
  readonly sourceSha: string;
  readonly repository: string;
  readonly candidateDir: string;
  readonly includeMacosArm64?: boolean;
  /**
   * Native inspection evidence files to consume for components this host cannot
   * open. Each must be bound to the artifact's exact digest.
   */
  readonly inspectionEvidence?: ReadonlyArray<string> | undefined;
}

/** The per-target asset each target is responsible for producing. */
export function candidateTargetAssets(
  target: CandidateTarget,
  version: string,
  options: { readonly includeMacosArm64?: boolean } = {},
): ReadonlyArray<string> {
  if (target === "linux") return [`t3-${version}-linux-x64.tar.gz`];
  if (target === "win") {
    return [`T3-Code-${version}-x64.exe`, `t3-${version}-win32-x64.zip`];
  }
  // Apple Silicon is optional and deferred; it must never be demanded unless the
  // caller explicitly asked for it, or an Intel-only build fails at staging.
  const mac = [`T3-Code-${version}-x64.dmg`];
  if (options.includeMacosArm64 === true) mac.push(`T3-Code-${version}-arm64.dmg`);
  return mac;
}

/**
 * Where a target's native resource monitor is staged for its CLI archive.
 *
 * The layout mirrors the reusable workflow's `Stage resource monitor for the CLI
 * archive` step (`$RUNNER_TEMP/cli-resource-monitor/${{ inputs.resource_key }}`):
 * `build-cli-archive.ts` copies the whole `--resource-monitor-dir`, and the
 * runtime resolves `resource-monitor/<platformKey>/<binary>`. Only Linux and
 * Windows ship a `t3` CLI archive, so only they stage a helper.
 */
export interface ResourceMonitorStaging {
  readonly platformKey: string;
  readonly binaryName: string;
  readonly rustTarget: string;
  /** Repo-relative path of the cargo build output for this target. */
  readonly sourceRelativePath: string;
  /** `--resource-monitor-dir`-relative path the CLI archive must consume. */
  readonly destinationRelativePath: string;
}

export function candidateResourceMonitorStaging(target: CandidateTarget): ResourceMonitorStaging {
  if (target === "linux") {
    return {
      platformKey: "linux-x64",
      binaryName: "t3-resource-monitor",
      rustTarget: "x86_64-unknown-linux-gnu",
      // The local Linux plan builds for the host, so cargo writes plain
      // `target/release/` rather than a target-specific subdirectory.
      sourceRelativePath: "native/resource-monitor/target/release/t3-resource-monitor",
      destinationRelativePath: "linux-x64/t3-resource-monitor",
    };
  }
  if (target === "win") {
    return {
      platformKey: "win32-x64",
      binaryName: "t3-resource-monitor.exe",
      rustTarget: "x86_64-pc-windows-msvc",
      sourceRelativePath:
        "native/resource-monitor/target/x86_64-pc-windows-msvc/release/t3-resource-monitor.exe",
      destinationRelativePath: "win32-x64/t3-resource-monitor.exe",
    };
  }
  throw new Error(
    "the Intel macOS target ships no t3 CLI archive, so it stages no resource monitor",
  );
}

export interface StageResourceMonitorInput {
  readonly target: CandidateTarget;
  readonly resourceMonitorDir: string;
  /** Repo root the cargo output is resolved from (normally `process.cwd()`). */
  readonly repoRoot: string;
}

/**
 * Copies the freshly built native helper into the directory the CLI archive
 * consumes. It fails closed when the cargo output is missing, so a stale or
 * wrong-toolchain helper can never be silently staged; the source path is the
 * only input, and the bytes are copied verbatim.
 */
export function stageCandidateResourceMonitor(input: StageResourceMonitorInput): string {
  const staging = candidateResourceMonitorStaging(input.target);
  const source = NodePath.join(input.repoRoot, staging.sourceRelativePath);
  if (!NodeFS.existsSync(source) || !NodeFS.statSync(source).isFile()) {
    throw new Error(
      `the ${input.target} resource monitor build output is missing at ${staging.sourceRelativePath}; ` +
        `build it first: cargo build --locked --release --target ${staging.rustTarget} --manifest-path native/resource-monitor/Cargo.toml`,
    );
  }
  const destinationDir = NodePath.join(input.resourceMonitorDir, staging.platformKey);
  NodeFS.mkdirSync(destinationDir, { recursive: true });
  const destination = NodePath.join(destinationDir, staging.binaryName);
  NodeFS.copyFileSync(source, destination);
  return destination;
}

/** The steps that build one target's artifacts into `outputDir`. */
export function planCandidateBuild(input: CandidatePlanInput): ReadonlyArray<CandidatePlanStep> {
  const base = input.assumeInstalled
    ? []
    : [
        {
          id: "install",
          description: "Install workspace dependencies",
          command: ["vp", "install"],
          phase: "install" as const,
        },
      ];

  if (input.target === "linux") {
    return [
      ...base,
      {
        id: "align-version",
        description: "Align package versions to the fork release version",
        command: ["node", "scripts/update-release-package-versions.ts", input.version],
        phase: "build",
      },
      {
        id: "bundle",
        description: "Build the server/web bundle",
        command: ["vp", "run", "--filter", "t3", "build"],
        phase: "build",
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
        phase: "build",
      },
      {
        id: "sea",
        description: "Build the Linux single-executable",
        command: ["node", "apps/server/scripts/cli.ts", "build-exe", "--verbose"],
        phase: "build",
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
        phase: "build",
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
        phase: "verify",
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
      ...base,
      {
        id: "align-version",
        description: "Align package versions to the fork release version",
        command: ["node", "scripts/update-release-package-versions.ts", input.version],
        phase: "build",
      },
      {
        id: "resource-monitor",
        description: "Build the Windows resource monitor from source",
        command: [
          "cargo",
          "build",
          "--locked",
          "--release",
          "--target",
          "x86_64-pc-windows-msvc",
          "--manifest-path",
          "native/resource-monitor/Cargo.toml",
        ],
        phase: "build",
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
          "--build-version",
          input.version,
          "--output-dir",
          input.outputDir,
          "--wsl-runtime",
          input.linuxArchive,
          "--verbose",
        ],
        phase: "build",
      },
      {
        id: "sea",
        description: "Build the Windows single-executable for the CLI ZIP",
        command: ["node", "apps/server/scripts/cli.ts", "build-exe", "--verbose"],
        phase: "build",
      },
      {
        id: "cli-archive",
        description: "Assemble the Windows x64 self-contained CLI ZIP",
        command: [
          "node",
          "scripts/build-cli-archive.ts",
          "--platform",
          "win",
          "--arch",
          "x64",
          "--version",
          input.version,
          "--resource-monitor-dir",
          input.resourceMonitorDir,
          "--output-dir",
          input.outputDir,
        ],
        phase: "build",
      },
      {
        id: "smoke",
        description: "Smoke-test the Windows CLI archive",
        command: [
          "node",
          "scripts/smoke-cli-archive.ts",
          "--archive",
          `${input.outputDir}/t3-${input.version}-win32-x64.zip`,
          "--expect-version",
          input.version,
        ],
        phase: "verify",
      },
    ];
  }

  return [
    ...base,
    {
      id: "align-version",
      description: "Align package versions to the fork release version",
      command: ["node", "scripts/update-release-package-versions.ts", input.version],
      phase: "build",
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
        "--build-version",
        input.version,
        "--output-dir",
        input.outputDir,
        "--verbose",
      ],
      phase: "build",
    },
    ...(input.includeMacosArm64 === true
      ? [
          {
            id: "desktop-arm64",
            description: "Package the Apple Silicon macOS arm64 DMG (optional target)",
            command: [
              "node",
              "scripts/build-desktop-artifact.ts",
              "--platform",
              "mac",
              "--target",
              "dmg",
              "--arch",
              "arm64",
              "--build-version",
              input.version,
              "--output-dir",
              input.outputDir,
              "--verbose",
            ],
            phase: "build" as const,
          },
        ]
      : []),
  ];
}

/**
 * Per-target verification: checks that this platform's own required assets are
 * present, non-empty, and carry matching embedded provenance. It must NOT
 * require other platforms; the aggregate verifier owns the complete set.
 */
export function planCandidateTargetVerification(input: {
  readonly target: CandidateTarget;
  readonly version: string;
  readonly sourceSha: string;
  readonly repository: string;
  readonly candidateDir: string;
  /** When set, write this host's native inspection evidence here. */
  readonly emitInspection?: string | undefined;
}): CandidatePlanStep {
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
    "--targets",
    input.target,
  ];
  if (input.emitInspection !== undefined) {
    command.push("--emit-inspection", input.emitInspection);
  }
  return {
    id: `verify-${input.target}`,
    description: `Verify the ${input.target} artifacts' presence and embedded provenance`,
    command,
    phase: "verify",
  };
}

/**
 * The aggregate step: gathers all native outputs already staged in the
 * candidate directory, then freezes the manifest/checksums and verifies the
 * complete required artifact set. This is the step that can fail when a
 * platform is missing.
 */
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
  if (input.inspectionEvidence !== undefined && input.inspectionEvidence.length > 0) {
    command.push("--inspection-evidence", input.inspectionEvidence.join(","));
  }
  return {
    id: "verify",
    description: "Freeze the manifest/checksums and verify the complete candidate bytes",
    command,
    phase: "aggregate",
  };
}

/** Steps that copy a platform's freshly built files into the shared candidate dir. */
export function planCandidateStaging(input: {
  readonly target: CandidateTarget;
  readonly version: string;
  readonly outputDir: string;
  readonly includeMacosArm64?: boolean | undefined;
}): ReadonlyArray<CandidatePlanStep> {
  return candidateTargetAssets(input.target, input.version, {
    includeMacosArm64: input.includeMacosArm64 === true,
  }).map((asset) => ({
    id: `stage-${asset}`,
    description: `Stage ${asset} into the shared candidate directory`,
    command: [
      "node",
      "scripts/stage-candidate-asset.ts",
      "--file",
      asset,
      "--output-dir",
      input.outputDir,
    ],
    phase: "stage" as const,
  }));
}
