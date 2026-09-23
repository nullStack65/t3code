#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A machine-local orchestrator that shells out to the repo's own build scripts.
/**
 * Machine-local candidate build route.
 *
 * Use this when no authorized CI runner is available. It runs the same
 * packaging and verification scripts the workflow runs, on the authorized
 * Windows/WSL and Intel macOS sessions, and writes the same candidate layout
 * (`fork-release-manifest.json`, `SHA256SUMS`, assets) that `qualify` writes.
 *
 * It is two-phase on purpose:
 *   - `--phase target` (default) builds, stages, and verifies *one* platform
 *     into the shared output directory. It never requires another platform, so
 *     a Linux-only build can succeed before a macOS DMG exists.
 *   - `--phase aggregate` freezes the manifest/checksums and verifies the
 *     complete required artifact set across every platform. Run it after the
 *     native outputs have been gathered.
 *
 * Source selection is explicit:
 *   - `--mode public` (default) requires the SHA to be an ancestor of the fork
 *     remote's `main`;
 *   - `--mode candidate` accepts any commit on the fork remote, which is what
 *     lets a pre-merge PR head be built without faking main ancestry.
 *
 * Native acceptance receipts are still required before publication; this tool
 * never invents one.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  planCandidateBuild,
  planCandidateStaging,
  planCandidateTargetVerification,
  planCandidateVerification,
  type CandidatePlanStep,
  type CandidateTarget,
} from "./lib/candidate-build-plan.ts";

type Phase = "target" | "aggregate";
type SourceMode = "public" | "candidate";

interface Args {
  target: CandidateTarget;
  phase: Phase;
  version: string;
  sha: string;
  repository: string;
  forkRemote: string;
  mode: SourceMode;
  outputDir: string;
  resourceMonitorDir: string;
  linuxArchive: string | undefined;
  includeMacosArm64: boolean;
  assumeInstalled: boolean;
  execute: boolean;
  keepGoing: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      flags.add(key);
    }
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value.trim() === "") throw new Error(`--${key} is required`);
    return value.trim();
  };
  const target = required("target");
  if (target !== "linux" && target !== "win" && target !== "mac") {
    throw new Error("--target must be linux, win, or mac");
  }
  const phase = values.get("phase")?.trim() || "target";
  if (phase !== "target" && phase !== "aggregate") {
    throw new Error("--phase must be target or aggregate");
  }
  const mode = values.get("mode")?.trim() || "public";
  if (mode !== "public" && mode !== "candidate") {
    throw new Error("--mode must be public or candidate");
  }
  return {
    target,
    phase,
    version: required("version"),
    sha: required("sha").toLowerCase(),
    repository: values.get("repository")?.trim() || "nullStack65/t3code",
    forkRemote: values.get("fork-remote")?.trim() || "fork",
    mode,
    outputDir: values.get("output-dir")?.trim() || "candidate",
    resourceMonitorDir:
      values.get("resource-monitor-dir")?.trim() ||
      NodePath.join(NodeOS.tmpdir(), "t3-candidate-resource-monitor"),
    linuxArchive: values.get("linux-archive")?.trim(),
    includeMacosArm64: flags.has("include-macos-arm64"),
    assumeInstalled: flags.has("assume-installed"),
    execute: flags.has("execute"),
    keepGoing: flags.has("keep-going"),
  };
}

function run(step: CandidatePlanStep, args: Args): void {
  console.log(`\n$ ${step.command.join(" ")}`);
  const command = step.command[0]!;
  const result = NodeChildProcess.spawnSync(command, step.command.slice(1), {
    stdio: "inherit",
    shell: HostProcessPlatform.defaultValue() === "win32",
    env: childEnv(args),
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    throw new Error(`step '${step.id}' failed with exit code ${result.status ?? "unknown"}`);
  }
}

/**
 * Binds the requested source/repository/release mode into every child process so
 * the embedded provenance is the selected SHA, not an ambient or dispatch value.
 */
function childEnv(args: Args): NodeJS.ProcessEnv {
  return {
    ...process.env,
    T3CODE_RELEASE_BUILD: "1",
    T3CODE_SOURCE_SHA: args.sha,
    T3CODE_SOURCE_REPOSITORY: args.repository,
    T3CODE_SOURCE_MODE: args.mode,
  };
}

/** Resolves the writable fork remote rather than assuming `origin` is the fork. */
function resolveForkRemote(args: Args): { remote: string; url: string } {
  const preferred = args.forkRemote;
  const candidates = [preferred, "fork", "origin"];
  for (const remote of candidates) {
    const result = NodeChildProcess.spawnSync("git", ["remote", "get-url", remote], {
      encoding: "utf8",
    });
    if (result.status !== 0) continue;
    const url = (result.stdout ?? "").trim();
    if (url.toLowerCase().includes(args.repository.toLowerCase())) {
      return { remote, url };
    }
  }
  // Fall back to whichever remote exists, but say so loudly; provenance is
  // still bound by T3CODE_SOURCE_REPOSITORY above.
  for (const remote of candidates) {
    const result = NodeChildProcess.spawnSync("git", ["remote", "get-url", remote], {
      encoding: "utf8",
    });
    if (result.status === 0 && (result.stdout ?? "").trim() !== "") {
      console.warn(
        `warn: no local remote points at ${args.repository}; using '${remote}' as the source of the candidate SHA.`,
      );
      return { remote, url: (result.stdout ?? "").trim() };
    }
  }
  throw new Error(
    `no git remote found for ${args.repository}; pass --fork-remote <name> naming the writable fork remote.`,
  );
}

function runGit(args: ReadonlyArray<string>): { stdout: string; status: number } {
  const result = NodeChildProcess.spawnSync("git", [...args], { encoding: "utf8" });
  return { stdout: (result.stdout ?? "").trim(), status: result.status ?? 1 };
}

function assertSource(args: Args): void {
  const { remote, url } = resolveForkRemote(args);
  console.log(`Fork remote: ${remote} -> ${url}`);

  const head = runGit(["rev-parse", "HEAD"]).stdout.toLowerCase();
  if (head !== args.sha) {
    throw new Error(
      `checked-out HEAD ${head} does not match requested source ${args.sha}; check out the release SHA first.`,
    );
  }

  // Ensure the requested SHA was actually fetched from the fork remote.
  const hasCommit = runGit(["cat-file", "-e", `${args.sha}^{commit}`]).status === 0;
  if (!hasCommit) {
    throw new Error(`requested source ${args.sha} is not present in this checkout`);
  }

  const onForkMain =
    runGit(["merge-base", "--is-ancestor", args.sha, `${remote}/main`]).status === 0;
  if (args.mode === "public" && !onForkMain) {
    throw new Error(
      `${args.sha} is not an ancestor of ${remote}/main; use --mode candidate for a pre-merge PR head.`,
    );
  }
  console.log(
    `Source verified: ${args.sha} (HEAD; mode ${args.mode}; ${onForkMain ? `on ${remote}/main` : "not on main — candidate-only"}).`,
  );
}

function stageResourceMonitor(args: Args): void {
  const target = NodePath.join(args.resourceMonitorDir, "linux-x64");
  NodeFS.mkdirSync(target, { recursive: true });
  NodeFS.copyFileSync(
    NodePath.join("native/resource-monitor/target/release/t3-resource-monitor"),
    NodePath.join(target, "t3-resource-monitor"),
  );
  console.log(`Staged resource monitor into ${target}`);
}

function buildPlan(args: Args): ReadonlyArray<CandidatePlanStep> {
  return planCandidateBuild({
    target: args.target,
    version: args.version,
    outputDir: args.outputDir,
    resourceMonitorDir: args.resourceMonitorDir,
    linuxArchive: args.linuxArchive,
    assumeInstalled: args.assumeInstalled,
  });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const aggregateStep = planCandidateVerification({
    version: args.version,
    sourceSha: args.sha,
    repository: args.repository,
    candidateDir: args.outputDir,
    includeMacosArm64: args.includeMacosArm64,
  });

  if (args.phase === "aggregate") {
    console.log(`Aggregate candidate freeze for ${args.repository} v${args.version} @ ${args.sha}`);
    console.log(`  - ${aggregateStep.id}: ${aggregateStep.description}`);
    console.log(`      ${aggregateStep.command.join(" ")}`);
    if (!args.execute) {
      console.log("\nDry run. Pass --execute to run this step.");
      return;
    }
    run(aggregateStep, args);
    console.log("\nAggregate candidate frozen and verified.");
    return;
  }

  const buildSteps = buildPlan(args);
  const stageSteps = planCandidateStaging({
    target: args.target,
    version: args.version,
    outputDir: args.outputDir,
  });
  const verifyStep = planCandidateTargetVerification({
    target: args.target,
    version: args.version,
    sourceSha: args.sha,
    repository: args.repository,
    candidateDir: args.outputDir,
  });
  const steps = [...buildSteps, ...stageSteps, verifyStep];

  console.log(
    `Machine-local candidate plan for ${args.target} (${args.repository} v${args.version}, mode ${args.mode})`,
  );
  for (const step of steps) {
    console.log(`  - [${step.phase}] ${step.id}: ${step.description}`);
    console.log(`      ${step.command.join(" ")}`);
  }

  if (!args.execute) {
    console.log("\nDry run. Pass --execute to run these steps.");
    console.log(
      "Prerequisites for a clean checkout: git + the pinned Node toolchain, `vp` (Vite+), and Rust (cargo).",
    );
    return;
  }

  assertSource(args);
  NodeFS.mkdirSync(args.outputDir, { recursive: true });

  // Install once, then build; never abort the whole run for one optional step.
  for (const step of buildSteps) {
    try {
      if (step.id === "resource-monitor" && args.target === "linux") {
        run(step, args);
        stageResourceMonitor(args);
        continue;
      }
      run(step, args);
    } catch (error) {
      if (!args.keepGoing) throw error;
      console.error(`step '${step.id}' failed; preserving completed outputs and continuing.`);
      console.error(String(error));
    }
  }
  for (const step of stageSteps) run(step, args);
  run(verifyStep, args);
  console.log(
    `\n${args.target} artifacts staged into ${args.outputDir} and verified. Run the other platforms, gather their outputs, then run --phase aggregate. Native acceptance receipts are still required before publication.`,
  );
}

main();
