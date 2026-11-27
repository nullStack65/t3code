#!/usr/bin/env node
// Measure how far the fork's release line has drifted from upstream/main.
//
// Prints one JSON object and exits 1 when the line is behind by more than the
// budget. Read-only: it never fetches, merges or writes. The weekly receipt is
// `node scripts/fork-drift-receipt.mjs --base origin/release/native-0.1.10`.
// In a pull request, CI also passes `--head <PR head SHA>` so the receipt
// measures the candidate, not just the target branch.

import * as NodeChildProcess from "node:child_process";

export const UPSTREAM_REF = "upstream/main";
export const CONFLICT_BUDGET = 25;
export const BEHIND_BUDGET = 300;

// Every ref is resolved to its tip SHA once, and all numbers come from those
// SHAs, so a later run with `--base <baseSha> --head <headSha> --upstream
// <upstreamSha>` reproduces the receipt after the refs have moved.
//
// `head` is the pull request candidate. Drift is measured for the commit that
// would land, which is the merge of `base` and `head`: commits in either tip
// but not in upstream are ahead, upstream commits in neither tip are behind.
// Without `head` (a push or the weekly run) the candidate is `base` itself.
export function measure(root, { baseRef, headRef = baseRef, upstreamRef = UPSTREAM_REF }) {
  const baseSha = resolveCommit(root, baseRef);
  const headSha = resolveCommit(root, headRef);
  const upstreamSha = resolveCommit(root, upstreamRef);
  const tips = baseSha === headSha ? [baseSha] : [baseSha, headSha];
  const ahead = count(root, [...tips, `^${upstreamSha}`]);
  const behind = count(root, [upstreamSha, ...tips.map((sha) => `^${sha}`)]);
  // With more than two commits, merge-base pairs the first with a hypothetical
  // merge of the rest, which is exactly the candidate merge of base and head.
  const mergeBase = git(root, ["merge-base", upstreamSha, ...tips]).trim();
  const names = git(root, ["diff", "--name-only", mergeBase, upstreamSha])
    .split("\n")
    .filter((name) => name.length > 0);
  return {
    baseRef,
    baseSha,
    headRef,
    headSha,
    upstreamRef,
    upstreamSha,
    mergeBase,
    ahead,
    behind,
    changedFiles: names.length,
  };
}

export function resolveCommit(root, ref) {
  if (typeof ref !== "string" || ref.length === 0 || ref.startsWith("-")) {
    throw new Error(`invalid ref: ${String(ref)}`);
  }
  return git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
}

function count(root, revs) {
  const raw = git(root, ["rev-list", "--count", ...revs]).trim();
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`unexpected rev-list output: ${raw}`);
  }
  return value;
}

export function budgetFindings(drift, behindBudget = BEHIND_BUDGET) {
  const findings = [];
  if (drift.behind > behindBudget) {
    findings.push(`behind ${drift.behind} commits, budget is ${behindBudget}`);
  }
  return findings;
}

function git(root, args) {
  return NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} needs a ref`);
  }
  return value;
}

function main() {
  const args = process.argv.slice(2);
  const baseRef = option(args, "--base") ?? "HEAD";
  const headRef = option(args, "--head") ?? baseRef;
  const upstreamRef = option(args, "--upstream") ?? UPSTREAM_REF;
  const root = option(args, "--root") ?? process.cwd();
  const drift = measure(root, { baseRef, headRef, upstreamRef });
  const findings = budgetFindings(drift);
  const receipt = {
    ...drift,
    reproduce: `node scripts/fork-drift-receipt.mjs --base ${drift.baseSha} --head ${drift.headSha} --upstream ${drift.upstreamSha}`,
    behindBudget: BEHIND_BUDGET,
    conflictBudget: CONFLICT_BUDGET,
    findings,
  };
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
