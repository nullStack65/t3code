import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";

import { conflictPaths, proposalBody } from "./fork-sync-plan.mjs";

const scriptDir = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const base = "release/native-0.1.10";
const branch = "sync/upstream-proposal-2026-11-23-0-1";
const isolated = { ...process.env };
for (const key of Object.keys(isolated)) {
  if (key.startsWith("GIT_") || key.startsWith("GITHUB_RUN_")) delete isolated[key];
}
isolated.GIT_CONFIG_GLOBAL = "/dev/null";
isolated.GIT_CONFIG_NOSYSTEM = "1";

function git(cwd, ...args) {
  return NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: isolated,
  }).trim();
}

function commit(cwd, file, contents) {
  NodeFS.writeFileSync(NodePath.join(cwd, file), contents);
  git(cwd, "add", file);
  git(
    cwd,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    file,
  );
  return git(cwd, "rev-parse", "HEAD");
}

function fixture(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-sync-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const work = NodePath.join(root, "work");
  const upstream = NodePath.join(root, "upstream");
  const origin = NodePath.join(root, "origin.git");
  const bin = NodePath.join(root, "bin");
  for (const dir of [work, origin, bin]) NodeFS.mkdirSync(dir);
  git(work, "init", "-qb", base);
  const common = commit(work, "README.md", "base\n");
  git(origin, "init", "-q", "--bare");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", base);
  git(root, "clone", "-q", work, upstream);
  git(upstream, "switch", "-qc", "main");
  NodeFS.mkdirSync(NodePath.join(work, "scripts"));
  for (const name of ["fork-drift-receipt.mjs", "fork-sync-plan.mjs", "upstream-sync.sh"]) {
    NodeFS.cpSync(NodePath.join(scriptDir, name), NodePath.join(work, "scripts", name));
  }
  NodeFS.writeFileSync(
    NodePath.join(bin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_FIXTURE/log"
case "$*" in
  'api user --jq .login') printf '%s\n' "\${FIXTURE_ACTOR:-nullStack65}" ;;
  'api --paginate --method GET '*) cat "$GH_FIXTURE/open" ;;
  'pr create '*)
    while [[ "$1" != --body-file ]]; do shift; done
    cp "$2" "$GH_FIXTURE/body" ;;
  'api --method PATCH '*)
    for arg do case "$arg" in body=@*) cp "\${arg#body=@}" "$GH_FIXTURE/body" ;; esac; done ;;
  'pr ready '*) ;;
  *) exit 90 ;;
esac
`,
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(NodePath.join(root, "open"), "[]\n");
  function run(extra = {}) {
    return NodeChildProcess.spawnSync("bash", ["scripts/upstream-sync.sh"], {
      cwd: work,
      encoding: "utf8",
      env: {
        ...isolated,
        PATH: `${bin}:${process.env.PATH}`,
        UPSTREAM_URL: upstream,
        SYNC_DATE: "2026-11-23",
        GH_FIXTURE: root,
        GH_TOKEN: "fixture",
        ...extra,
      },
    });
  }
  function open(head, ref = branch, draft = true, login = "nullStack65") {
    NodeFS.writeFileSync(
      NodePath.join(root, "open"),
      JSON.stringify([
        {
          number: 1,
          draft,
          user: { login },
          head: { ref, sha: head, repo: { full_name: "nullStack65/t3code" } },
        },
      ]),
    );
  }
  return {
    work,
    upstream,
    origin,
    common,
    run,
    open,
    log: () => NodeFS.readFileSync(NodePath.join(root, "log"), "utf8"),
    body: () => NodeFS.readFileSync(NodePath.join(root, "body"), "utf8"),
  };
}

NodeTest.test("conflict paths stop before git's messages and preserve unusual filenames", () => {
  NodeAssert.deepEqual(conflictPaths("tree\0ordinary.ts\0new\nline.ts\0\0message\0"), [
    "ordinary.ts",
    "new\nline.ts",
  ]);
  NodeAssert.match(
    proposalBody({ mode: "conflict", files: ["new\nline.ts"] }),
    /    "new\\nline.ts"/,
  );
});

NodeTest.test(
  "a conflict opens one draft and a later run updates its body even after the date changes",
  (t) => {
    const f = fixture(t);
    const release = commit(f.work, "README.md", "fork\n");
    git(f.work, "push", "-q", "origin", base);
    const upstream = commit(f.upstream, "README.md", "upstream\n");
    const first = f.run({ ADMITTED_UPSTREAM_SHA: upstream });
    NodeAssert.equal(first.status, 0, first.stderr);
    const head = git(f.origin, "rev-parse", branch);
    NodeAssert.equal(git(f.origin, "rev-parse", `${head}^`), release);
    for (const sha of [head, release, upstream, f.common])
      NodeAssert.match(f.body(), new RegExp(sha));
    NodeAssert.match(f.body(), /Conflicts in 1 files[\s\S]*"README.md"/);
    NodeAssert.match(f.body(), /--is-ancestor upstream proposal-head: `1`/);
    NodeAssert.match(f.log(), /pr create .* --draft/);
    f.open(head);
    const next = f.run({ SYNC_DATE: "2026-11-24" });
    NodeAssert.equal(next.status, 0, next.stderr);
    NodeAssert.match(f.log(), /PATCH repos\/nullStack65\/t3code\/pulls\/1/);
    NodeAssert.equal((f.log().match(/pr create/g) ?? []).length, 1);
    NodeAssert.equal(git(f.origin, "rev-parse", base), release);
  },
);

NodeTest.test(
  "a clean merge needs exact SHA admission and updates the same draft for real CI",
  (t) => {
    const f = fixture(t);
    const upstream = commit(f.upstream, "candidate.txt", "candidate\n");
    const first = f.run();
    NodeAssert.equal(first.status, 0, first.stderr);
    const oldHead = git(f.origin, "rev-parse", branch);
    NodeAssert.match(f.body(), /pending Platform \/ CTO admission/);
    f.open(oldHead);
    const admitted = f.run({ ADMITTED_UPSTREAM_SHA: upstream });
    NodeAssert.equal(admitted.status, 0, admitted.stderr);
    const head = git(f.origin, "rev-parse", branch);
    NodeAssert.equal(git(f.origin, "rev-parse", `${head}^1`), oldHead);
    NodeAssert.equal(git(f.origin, "rev-parse", `${head}^2`), upstream);
    NodeAssert.equal(git(f.origin, "rev-parse", base), f.common);
    NodeAssert.match(f.body(), /--is-ancestor upstream proposal-head: `0`/);
    NodeAssert.match(f.body(), /Deploy: none/);
    NodeAssert.match(f.log(), /pr ready 1 --repo/);
    NodeAssert.doesNotMatch(git(f.origin, "ls-tree", "-r", "--name-only", head), /pending\.md/);
  },
);

NodeTest.test(
  "missing or CI-ineligible credentials and a hand-owned proposal prevent publication",
  (t) => {
    const f = fixture(t);
    const upstream = commit(f.upstream, "candidate.txt", "candidate\n");
    NodeAssert.match(f.run({ GH_TOKEN: "" }).stderr, /T3_FORK_SYNC_TOKEN/);
    NodeAssert.match(f.run({ FIXTURE_ACTOR: "github-actions[bot]" }).stderr, /CI-admitted/);
    f.open(f.common, "sync/upstream-antigravity-acp-20261120", false);
    const existing = f.run({ ADMITTED_UPSTREAM_SHA: upstream });
    NodeAssert.equal(existing.status, 0, existing.stderr);
    NodeAssert.match(existing.stdout, /owned by the existing PR #1/);
    NodeAssert.doesNotMatch(f.log(), /pr create|PATCH|pr merge/);
  },
);

NodeTest.test(
  "a short-lived App token authenticates by its bot login and owns its own proposal",
  (t) => {
    const f = fixture(t);
    const release = commit(f.work, "README.md", "fork\n");
    git(f.work, "push", "-q", "origin", base);
    const upstream = commit(f.upstream, "README.md", "upstream\n");
    // An installation token cannot read /user, so the fixture's answer there must never matter.
    const app = { SYNC_APP_ACTOR: "t3-sync[bot]", FIXTURE_ACTOR: "not-consulted" };
    const first = f.run({ ADMITTED_UPSTREAM_SHA: upstream, ...app });
    NodeAssert.equal(first.status, 0, first.stderr);
    NodeAssert.doesNotMatch(f.log(), /api user/);
    const head = git(f.origin, "rev-parse", branch);
    NodeAssert.equal(git(f.origin, "rev-parse", `${head}^`), release);
    f.open(head, branch, true, "t3-sync[bot]");
    const next = f.run({ SYNC_DATE: "2026-11-24", ...app });
    NodeAssert.equal(next.status, 0, next.stderr);
    NodeAssert.match(f.log(), /PATCH repos\/nullStack65\/t3code\/pulls\/1/);
    NodeAssert.equal((f.log().match(/pr create/g) ?? []).length, 1);
  },
);
