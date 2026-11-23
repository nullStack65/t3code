#!/usr/bin/env node
// Decide what the daily upstream sync may do. It never resolves conflicts and
// never allows a force-push. The shell in scripts/upstream-sync.sh performs
// the fetch and the push this decision names.

import { readFileSync } from "node:fs";

import { CONFLICT_BUDGET } from "./fork-drift-receipt.mjs";

export { CONFLICT_BUDGET };

const OWNER = "Platform / CTO";

export function decideSync({
  behind = 0,
  conflictFiles = [],
  pushRejected = false,
  mergeFailed = false,
} = {}) {
  const files = conflictFiles.filter((name) => name.length > 0);
  if (pushRejected) {
    return {
      action: "flag-diverged",
      allowForcePush: false,
      owner: OWNER,
      files,
    };
  }
  if (files.length > 0 || mergeFailed) {
    return {
      action: "flag-conflicts",
      allowForcePush: false,
      owner: OWNER,
      overBudget: files.length > CONFLICT_BUDGET,
      files,
    };
  }
  if (behind === 0) return { action: "up-to-date", allowForcePush: false, files: [] };
  return { action: "open-pr", allowForcePush: false, files: [] };
}

export function pullRequestBody({ behind, ahead, mergeBase, ciWillStart }) {
  const checks = ciWillStart
    ? "A repository secret opened this pull request, so the fork checks can start."
    : "No T3_FORK_SYNC_TOKEN secret is set, so this pull request was opened with the default GitHub token. That token does not start other workflows. Platform / CTO: set T3_FORK_SYNC_TOKEN to a nullStack65 token, or push an empty commit as nullStack65, before treating CI as run. Do not merge while the required checks are missing.";
  return [
    `Upstream main is ${behind} commits ahead of release/native-0.1.10. The fork has ${ahead} commits that are not upstream. Merge base \`${mergeBase}\`.`,
    "",
    "This merges upstream/main into a branch cut from the release line. The workflow does not merge the pull request.",
    "",
    checks,
    "",
    "Model: github-actions",
    "Task: sync",
    "",
    "Deploy: fleet",
    "",
  ].join("\n");
}

export function issueBody({ decision, behind, ahead, mergeBase, date }) {
  const files = decision.files ?? [];
  const budget =
    decision.overBudget === true
      ? `Conflicts in ${files.length} files, past the ${CONFLICT_BUDGET}-file budget. This needs a decision before anyone resolves it.`
      : `Conflicts in ${files.length} file${files.length === 1 ? "" : "s"}. The daily sync does not resolve conflicts.`;
  const diverged =
    decision.action === "flag-diverged"
      ? "The sync branch already differs, so updating it would take a force-push. The push was not retried."
      : budget;
  return [
    `Platform / CTO: the upstream sync for ${date} stopped.`,
    "",
    diverged,
    `The release line is ${behind} commits behind upstream and ${ahead} commits ahead. Merge base \`${mergeBase}\`.`,
    "Do not force-push. Do not bypass CI.",
    "",
    "Files:",
    ...(files.length > 0
      ? files.map((name) => `- ${name}`)
      : ["- (push rejected before a file list was available)"]),
    "",
  ].join("\n");
}

function argument(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function main() {
  const args = process.argv.slice(2);
  const conflictsPath = argument(args, "--conflicts-file");
  const conflictFiles =
    conflictsPath === undefined
      ? []
      : readFileSync(conflictsPath, "utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
  const behind = Number(argument(args, "--behind") ?? "0");
  const ahead = Number(argument(args, "--ahead") ?? "0");
  const mergeBase = argument(args, "--merge-base") ?? "";
  const date = argument(args, "--date") ?? "";
  const ciWillStart = args.includes("--ci-will-start");
  const decision = decideSync({
    behind,
    conflictFiles,
    pushRejected: args.includes("--push-rejected"),
    mergeFailed: args.includes("--merge-failed"),
  });
  const body =
    decision.action === "open-pr"
      ? { pullRequest: pullRequestBody({ behind, ahead, mergeBase, ciWillStart }) }
      : decision.action === "up-to-date"
        ? {}
        : { issue: issueBody({ decision, behind, ahead, mergeBase, date }) };
  process.stdout.write(`${JSON.stringify({ ...decision, ...body })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`fork-sync-plan: ${error.message}\n`);
    process.exit(2);
  }
}
