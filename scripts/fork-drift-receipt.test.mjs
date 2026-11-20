import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { BEHIND_BUDGET, budgetFindings, measure } from "./fork-drift-receipt.mjs";

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), "fork-drift-"));
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
    execFileSync("bash", ["-c", `echo ${file} >> ${file}`], { cwd: root });
    git(root, ["add", file]);
    git(root, ["commit", "-q", "-m", file]);
    git(root, ["branch", "-M", branch]);
    return;
  }
  const exists = branches.split("\n").some((name) => name.trim().replace(/^[* ] /, "") === branch);
  git(root, exists ? ["checkout", "-q", branch] : ["checkout", "-q", "-b", branch]);
  execFileSync("bash", ["-c", `echo ${file} >> ${file}`], { cwd: root });
  git(root, ["add", file]);
  git(root, ["commit", "-q", "-m", file]);
}

test("counts commits the release line is behind", () => {
  const root = repo();
  try {
    commit(root, "base", "release");
    git(root, ["branch", "upstream"]);
    commit(root, "ours", "release");
    commit(root, "theirs-a", "upstream");
    commit(root, "theirs-b", "upstream");
    const drift = measure(root, "release", "upstream");
    assert.equal(drift.ahead, 1);
    assert.equal(drift.behind, 2);
    assert.equal(drift.changedFiles, 2);
    assert.deepEqual(budgetFindings(drift), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a line past the budget fails", () => {
  const findings = budgetFindings({ behind: BEHIND_BUDGET + 1 });
  assert.equal(findings.length, 1);
  assert.deepEqual(budgetFindings({ behind: BEHIND_BUDGET }), []);
});

test("a missing ref fails closed", () => {
  const root = repo();
  try {
    commit(root, "base", "release");
    assert.throws(() => measure(root, "release", "missing"), /missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
