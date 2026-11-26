#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { CONFLICT_BUDGET } from "./fork-drift-receipt.mjs";

// git merge-tree --name-only -z terminates its conflicted path list with an
// empty field before any informational messages. The first field is the tree.
export function conflictPaths(output) {
  const fields = output.split("\0");
  const end = fields.indexOf("", 1);
  return fields.slice(1, end === -1 ? fields.length : end);
}

export function proposalBody({
  mode,
  date,
  head,
  release,
  upstream,
  mergeBase,
  ahead,
  behind,
  files,
  ancestor,
}) {
  const title = {
    clean: "sync: upstream main",
    conflict: "sync: upstream conflicts for Platform / CTO",
    admission: "sync: upstream SHA pending Platform / CTO admission",
  }[mode];
  if (!title) throw new Error(`Unknown upstream sync mode: ${mode}`);
  return [
    title,
    "",
    `Run date: ${date} (UTC)`,
    `Proposal head: \`${head}\``,
    `Protected release: \`${release}\``,
    `Upstream main: \`${upstream}\``,
    `git merge-base release upstream: \`${mergeBase}\``,
    `git merge-base --is-ancestor upstream proposal-head: \`${ancestor === "true" ? 0 : 1}\``,
    `Fork-only: ${ahead}. Upstream-only: ${behind}.`,
    "",
    ...(mode === "conflict"
      ? [
          `Conflicts in ${files.length} files (review budget: ${CONFLICT_BUDGET}).`,
          "",
          ...files.map((file) => `    ${JSON.stringify(file)}`),
        ]
      : mode === "admission"
        ? [
            "Platform / CTO can admit the exact upstream SHA via `T3_FORK_SYNC_ADMITTED_UPSTREAM_SHA` after reviewing the candidate source and workflows.",
          ]
        : [
            "The CI-admitted account updates this proposal. Platform / CTO owns the merge decision.",
          ]),
    "",
    "Deploy: none",
    "Model: github-actions",
    "Task: upstream-sync",
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [mode, date, head, release, upstream, mergeBase, ahead, behind, statusFile, ancestor] =
    process.argv.slice(2);
  const files = mode === "conflict" ? conflictPaths(NodeFS.readFileSync(statusFile, "utf8")) : [];
  process.stdout.write(
    proposalBody({
      mode,
      date,
      head,
      release,
      upstream,
      mergeBase,
      ahead,
      behind,
      files,
      ancestor,
    }),
  );
}
