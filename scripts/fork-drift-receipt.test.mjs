import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { BEHIND_BUDGET, budgetFindings, measure, resolveCommit } from "./fork-drift-receipt.mjs";

function git(root, args) {
  return NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function repo() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-drift-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "drift@example.com"]);
  git(root, ["config", "user.name", "drift"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  commit(root, "seed", "release");
  return root;
}

function commit(root, file, branch) {
  const branches = git(root, ["branch", "--list"]);
  if (branches.trim().length === 0) {
    NodeChildProcess.execFileSync("bash", ["-c", `echo ${file} >> ${file}`], { cwd: root });
    git(root, ["add", file]);
    git(root, ["commit", "-q", "-m", file]);
    git(root, ["branch", "-M", branch]);
    return;
  }
  const exists = branches.split("\n").some((name) => name.trim().replace(/^[* ] /, "") === branch);
  git(root, exists ? ["checkout", "-q", branch] : ["checkout", "-q", "-b", branch]);
  NodeChildProcess.execFileSync("bash", ["-c", `echo ${file} >> ${file}`], { cwd: root });
  git(root, ["add", file]);
  git(root, ["commit", "-q", "-m", file]);
}

NodeTest.test("counts commits the release line is behind", () => {
  const root = repo();
  try {
    commit(root, "base", "release");
    git(root, ["branch", "upstream"]);
    commit(root, "ours", "release");
    commit(root, "theirs-a", "upstream");
    commit(root, "theirs-b", "upstream");
    const drift = measure(root, { baseRef: "release", upstreamRef: "upstream" });
    NodeAssert.equal(drift.ahead, 1);
    NodeAssert.equal(drift.behind, 2);
    NodeAssert.equal(drift.changedFiles, 2);
    NodeAssert.deepEqual(budgetFindings(drift), []);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

NodeTest.test("a line past the budget fails", () => {
  const findings = budgetFindings({ behind: BEHIND_BUDGET + 1 });
  NodeAssert.equal(findings.length, 1);
  NodeAssert.deepEqual(budgetFindings({ behind: BEHIND_BUDGET }), []);
});

NodeTest.test("a missing ref fails closed", () => {
  const root = repo();
  try {
    commit(root, "base", "release");
    NodeAssert.throws(
      () => measure(root, { baseRef: "release", upstreamRef: "missing" }),
      /missing/,
    );
    NodeAssert.throws(
      () => measure(root, { baseRef: "release", headRef: "missing", upstreamRef: "release" }),
      /missing/,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

NodeTest.test("records tip SHAs and reproduces after the refs move", () => {
  const root = repo();
  try {
    commit(root, "base", "release");
    git(root, ["branch", "upstream"]);
    commit(root, "theirs-a", "upstream");
    commit(root, "theirs-b", "upstream");
    git(root, ["checkout", "-q", "release"]);
    git(root, ["checkout", "-q", "-b", "pr"]);
    git(root, ["merge", "-q", "--no-edit", "--no-ff", "upstream"]);
    commit(root, "ours", "release");

    const drift = measure(root, { baseRef: "release", headRef: "pr", upstreamRef: "upstream" });
    NodeAssert.equal(drift.baseSha, resolveCommit(root, "release"));
    NodeAssert.equal(drift.headSha, resolveCommit(root, "pr"));
    NodeAssert.equal(drift.upstreamSha, resolveCommit(root, "upstream"));
    NodeAssert.match(drift.baseSha, /^[0-9a-f]{40}$/);
    // The candidate is the merge of release and the pr: it carries the sync,
    // so it is not behind, while the target branch alone is two behind.
    NodeAssert.equal(drift.behind, 0);
    NodeAssert.equal(drift.ahead, 2);
    NodeAssert.equal(drift.mergeBase, drift.upstreamSha);
    NodeAssert.equal(drift.changedFiles, 0);
    NodeAssert.equal(measure(root, { baseRef: "release", upstreamRef: "upstream" }).behind, 2);

    commit(root, "later-ours", "release");
    commit(root, "later-pr", "pr");
    commit(root, "theirs-c", "upstream");
    NodeAssert.notEqual(resolveCommit(root, "upstream"), drift.upstreamSha);

    const replay = measure(root, {
      baseRef: drift.baseSha,
      headRef: drift.headSha,
      upstreamRef: drift.upstreamSha,
    });
    for (const key of [
      "baseSha",
      "headSha",
      "upstreamSha",
      "mergeBase",
      "ahead",
      "behind",
      "changedFiles",
    ]) {
      NodeAssert.equal(replay[key], drift[key], key);
    }
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

NodeTest.test("without a head the candidate is the base", () => {
  const root = repo();
  try {
    const drift = measure(root, { baseRef: "release", upstreamRef: "release" });
    NodeAssert.equal(drift.headRef, "release");
    NodeAssert.equal(drift.headSha, drift.baseSha);
    NodeAssert.equal(drift.ahead, 0);
    NodeAssert.equal(drift.behind, 0);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

NodeTest.test("an option-shaped ref is refused", () => {
  NodeAssert.throws(() => resolveCommit(process.cwd(), "--all"), /invalid ref/);
});
