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
 * Default is a dry run: it prints the exact plan. Pass `--execute` to run it.
 * A native acceptance receipt for each required target is still required before
 * publication; this tool never invents one.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  planCandidateBuild,
  planCandidateVerification,
  type CandidatePlanStep,
  type CandidateTarget,
} from "./lib/candidate-build-plan.ts";

interface Args {
  target: CandidateTarget;
  version: string;
  sha: string;
  repository: string;
  outputDir: string;
  resourceMonitorDir: string;
  linuxArchive: string | undefined;
  includeMacosArm64: boolean;
  execute: boolean;
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
  return {
    target,
    version: required("version"),
    sha: required("sha").toLowerCase(),
    repository: values.get("repository")?.trim() || "nullStack65/t3code",
    outputDir: values.get("output-dir")?.trim() || "candidate",
    resourceMonitorDir:
      values.get("resource-monitor-dir")?.trim() ||
      NodePath.join(NodeOS.tmpdir(), "t3-candidate-resource-monitor"),
    linuxArchive: values.get("linux-archive")?.trim(),
    includeMacosArm64: flags.has("include-macos-arm64"),
    execute: flags.has("execute"),
  };
}

const run = (step: CandidatePlanStep): void => {
  console.log(`\n$ ${step.command.join(" ")}`);
  const result = NodeChildProcess.spawnSync(step.command[0]!, step.command.slice(1), {
    stdio: "inherit",
    shell: HostProcessPlatform.defaultValue() === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`step '${step.id}' failed with exit code ${result.status ?? "unknown"}`);
  }
};

function assertSource(args: Args): void {
  const head = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (head.toLowerCase() !== args.sha) {
    throw new Error(`checked-out HEAD ${head} does not match requested source ${args.sha}`);
  }
  const ancestor = NodeChildProcess.spawnSync(
    "git",
    ["merge-base", "--is-ancestor", args.sha, "origin/main"],
    { stdio: "ignore" },
  );
  if (ancestor.status !== 0) {
    throw new Error(`${args.sha} is not an ancestor of origin/main`);
  }
  console.log(`Source verified: ${args.sha} (HEAD, ancestor of origin/main).`);
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

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const buildSteps = planCandidateBuild({
    target: args.target,
    version: args.version,
    outputDir: args.outputDir,
    resourceMonitorDir: args.resourceMonitorDir,
    linuxArchive: args.linuxArchive,
  });
  const verifyStep = planCandidateVerification({
    version: args.version,
    sourceSha: args.sha,
    repository: args.repository,
    candidateDir: args.outputDir,
    includeMacosArm64: args.includeMacosArm64,
  });

  console.log(
    `Machine-local candidate plan for ${args.target} (${args.repository} v${args.version})`,
  );
  for (const step of [...buildSteps, verifyStep]) {
    console.log(`  - ${step.id}: ${step.description}`);
    console.log(`      ${step.command.join(" ")}`);
  }

  if (!args.execute) {
    console.log("\nDry run. Pass --execute to run these steps.");
    return;
  }

  assertSource(args);
  NodeFS.mkdirSync(args.outputDir, { recursive: true });
  if (args.target === "linux") {
    run(buildSteps.find((step) => step.id === "resource-monitor")!);
    stageResourceMonitor(args);
    for (const step of buildSteps) {
      if (step.id === "resource-monitor") continue;
      run(step);
    }
  } else {
    for (const step of buildSteps) {
      run(step);
    }
  }
  run(verifyStep);
  console.log(
    "\nCandidate assembled and verified locally. Native acceptance receipts are still required before publication.",
  );
}

main();
