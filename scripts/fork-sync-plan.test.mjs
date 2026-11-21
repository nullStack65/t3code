import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CONFLICT_BUDGET, decideSync, issueBody, pullRequestBody } from "./fork-sync-plan.mjs";

const scriptDir = new URL(".", import.meta.url).pathname;

test("a clean lag opens a pull request and forbids a force-push", () => {
  const decision = decideSync({ behind: 4, conflictFiles: [] });
  assert.equal(decision.action, "open-pr");
  assert.equal(decision.allowForcePush, false);
});

test("any conflict flags Platform / CTO and does not resolve it", () => {
  const one = decideSync({ behind: 4, conflictFiles: ["apps/server/src/server.ts"] });
  assert.equal(one.action, "flag-conflicts");
  assert.equal(one.owner, "Platform / CTO");
  assert.equal(one.overBudget, false);
  assert.equal(one.allowForcePush, false);

  const files = Array.from({ length: CONFLICT_BUDGET + 1 }, (_, index) => `file-${index}.ts`);
  const over = decideSync({ behind: 783, conflictFiles: files });
  assert.equal(over.overBudget, true);
  assert.equal(over.allowForcePush, false);
});

test("a rejected push is not retried with force", () => {
  const decision = decideSync({ behind: 2, pushRejected: true });
  assert.equal(decision.action, "flag-diverged");
  assert.equal(decision.allowForcePush, false);
});

test("an up-to-date line does nothing", () => {
  assert.equal(decideSync({ behind: 0 }).action, "up-to-date");
});

test("the sync pull request body has one Deploy line", () => {
  const body = pullRequestBody({
    behind: 3,
    ahead: 1,
    mergeBase: "abc",
    ciWillStart: false,
  });
  const deploy = body.split("\n").filter((line) => line.startsWith("Deploy:"));
  assert.deepEqual(deploy, ["Deploy: fleet"]);
  assert.match(body, /Platform \/ CTO/);
  assert.match(body, /Model: github-actions/);
  assert.match(body, /Task: sync/);
});

test("the conflict issue names the owner and the files", () => {
  const decision = decideSync({
    behind: 2,
    conflictFiles: ["apps/web/src/components/Sidebar.tsx"],
  });
  const body = issueBody({
    decision,
    behind: 2,
    ahead: 9,
    mergeBase: "abc",
    date: "2026-11-21",
  });
  assert.match(body, /Platform \/ CTO/);
  assert.match(body, /Sidebar\.tsx/);
  assert.match(body, /Do not force-push/);
});

test("the workflow script never force-pushes or merges", () => {
  const source = readFileSync(join(scriptDir, "upstream-sync.sh"), "utf8");
  assert.equal(source.includes("--force"), false);
  assert.equal(source.includes("push -f"), false);
  assert.equal(source.includes("pr merge"), false);
});

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
}

function commit(cwd, file, contents, message) {
  writeFileSync(join(cwd, file), contents);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", "-m", message]);
}

function identity(cwd) {
  git(cwd, ["config", "user.email", "sync@example.com"]);
  git(cwd, ["config", "user.name", "sync"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "upstream-sync-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const upstream = join(root, "upstream");
  execFileSync("git", ["init", "-q", work]);
  identity(work);
  git(work, ["checkout", "-q", "-b", "release/native-0.1.10"]);
  commit(work, "README.md", "base\n", "base");
  execFileSync("git", ["init", "--bare", "-q", origin]);
  git(work, ["remote", "add", "origin", origin]);
  git(work, ["push", "-q", "origin", "release/native-0.1.10"]);
  execFileSync("git", ["clone", "-q", work, upstream]);
  identity(upstream);
  git(upstream, ["checkout", "-q", "-b", "main"]);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "pr list"|"issue list") exit 0 ;;
  "pr create") printf '%s\\n' "https://github.com/nullStack65/t3code/pull/1" ;;
  "issue create") printf '%s\\n' "https://github.com/nullStack65/t3code/issues/1" ;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  mkdirSync(join(work, "scripts"));
  for (const name of ["fork-drift-receipt.mjs", "fork-sync-plan.mjs", "upstream-sync.sh"]) {
    cpSync(join(scriptDir, name), join(work, "scripts", name));
  }
  chmodSync(join(work, "scripts", "upstream-sync.sh"), 0o755);
  return { root, origin, work, upstream, bin };
}

function decisionFrom(output) {
  const line = output.split("\n").findLast((entry) => entry.startsWith("{"));
  return JSON.parse(line);
}

function runSync(ctx, extraEnv = {}) {
  return execFileSync("bash", ["scripts/upstream-sync.sh"], {
    cwd: ctx.work,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${ctx.bin}:${process.env.PATH}`,
      GH_LOG: join(ctx.root, "gh.log"),
      UPSTREAM_URL: ctx.upstream,
      PUSH_REMOTE: "origin",
      GH_REPO: "nullStack65/t3code",
      SYNC_DATE: "2026-11-21",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...extraEnv,
    },
  });
}

test("a conflicting upstream flags and does not push", () => {
  const ctx = fixture();
  try {
    commit(ctx.work, "README.md", "fork\n", "fork");
    git(ctx.work, ["push", "-q", "origin", "release/native-0.1.10"]);
    commit(ctx.upstream, "README.md", "upstream\n", "upstream");
    const release = git(ctx.origin, ["rev-parse", "release/native-0.1.10"]).trim();
    const output = runSync(ctx, { DRY_RUN: "1" });
    const decision = decisionFrom(output);
    assert.equal(decision.action, "flag-conflicts");
    assert.equal(decision.allowForcePush, false);
    assert.ok(decision.files.includes("README.md"));
    assert.equal(git(ctx.origin, ["rev-parse", "release/native-0.1.10"]).trim(), release);
    assert.throws(() => git(ctx.origin, ["rev-parse", "sync/upstream-2026-11-21"]));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("a clean upstream opens a sync branch without moving the release line", () => {
  const ctx = fixture();
  try {
    commit(ctx.upstream, "upstream.txt", "new\n", "upstream feature");
    const release = git(ctx.origin, ["rev-parse", "release/native-0.1.10"]).trim();
    const output = runSync(ctx);
    const decision = decisionFrom(output);
    assert.equal(decision.action, "open-pr");
    assert.equal(decision.allowForcePush, false);
    assert.equal(git(ctx.origin, ["rev-parse", "release/native-0.1.10"]).trim(), release);
    assert.equal(git(ctx.origin, ["rev-parse", "sync/upstream-2026-11-21"]).trim().length, 40);
    const log = readFileSync(join(ctx.root, "gh.log"), "utf8");
    assert.match(log, /pr create/);
    assert.equal(log.includes("pr merge"), false);
    assert.equal(log.includes("--force"), false);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});
