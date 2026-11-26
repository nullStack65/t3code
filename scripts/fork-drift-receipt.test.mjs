import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { BEHIND_BUDGET, budgetFindings, measure } from "./fork-drift-receipt.mjs";

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
    const drift = measure(root, "release", "upstream");
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
    NodeAssert.throws(() => measure(root, "release", "missing"), /missing/);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
