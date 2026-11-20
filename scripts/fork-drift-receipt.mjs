#!/usr/bin/env node
// Measure how far the fork's release line has drifted from upstream/main.
//
// Prints one JSON object and exits 1 when the line is behind by more than the
// budget. Read-only: it never fetches, merges or writes. The weekly receipt is
// `node scripts/fork-drift-receipt.mjs --base origin/release/native-0.1.10`.

import { execFileSync } from "node:child_process";

export const UPSTREAM_REF = "upstream/main";
export const CONFLICT_BUDGET = 25;
export const BEHIND_BUDGET = 300;

export function measure(root, baseRef, upstreamRef = UPSTREAM_REF) {
  const revList = git(root, ["rev-list", "--left-right", "--count", `${baseRef}...${upstreamRef}`]);
  const [aheadRaw, behindRaw] = revList.trim().split(/\s+/);
  const ahead = Number(aheadRaw);
  const behind = Number(behindRaw);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
    throw new Error(`unexpected rev-list output: ${revList.trim()}`);
  }
  const mergeBase = git(root, ["merge-base", baseRef, upstreamRef]).trim();
  const names = git(root, ["diff", "--name-only", `${baseRef}...${upstreamRef}`])
    .split("\n")
    .filter((name) => name.length > 0);
  return { baseRef, upstreamRef, mergeBase, ahead, behind, changedFiles: names.length };
}

export function budgetFindings(drift, behindBudget = BEHIND_BUDGET) {
  const findings = [];
  if (drift.behind > behindBudget) {
    findings.push(`behind ${drift.behind} commits, budget is ${behindBudget}`);
  }
  return findings;
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function main() {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf("--base");
  const baseRef = baseIndex === -1 ? "HEAD" : args[baseIndex + 1];
  if (!baseRef) {
    throw new Error("--base needs a ref");
  }
  const rootIndex = args.indexOf("--root");
  const root = rootIndex === -1 ? process.cwd() : args[rootIndex + 1];
  const drift = measure(root, baseRef);
  const findings = budgetFindings(drift);
  const receipt = { ...drift, behindBudget: BEHIND_BUDGET, conflictBudget: CONFLICT_BUDGET, findings };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (findings.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`fork-drift-receipt: ${error.message}\n`);
    process.exit(2);
  }
}
