// Evaluates the real `if:` gates of the three ARC workers in
// closura-arc-ci.yml against pull_request and push event shapes. The
// evaluator covers the subset of GitHub Actions expressions the gates use, with
// GitHub's semantics: case-insensitive string equality, contains and startsWith,
// loose number/string equality, null for missing properties and short-circuit
// `&&`/`||` that return an operand.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/closura-arc-ci.yml"), "utf8");
const WORKERS = ["voice-and-inbox-core", "voice-and-inbox-web", "voice-and-inbox-mobile"];

function gateOf(job) {
  const match = workflow.match(
    new RegExp(`\\n  ${job}:\\n(?:    #.*\\n)*    if: >-\\n      \\$\\{\\{\\n([\\s\\S]*?)\\n      \\}\\}\\n`),
  );
  assert.ok(match, `${job} has no folded if: gate`);
  return match[1].split("\n").map((line) => line.trim()).join(" ");
}

function tokenize(source) {
  const tokens = [];
  const pattern = /\s+|('(?:[^']|'')*')|(\d+)|(&&|\|\||==|!=|!|\(|\)|,|\.)|([A-Za-z_][A-Za-z0-9_-]*)/y;
  let index = 0;
  while (index < source.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match) throw new Error(`unexpected input at ${source.slice(index, index + 20)}`);
    index = pattern.lastIndex;
    if (match[1]) tokens.push({ type: "str", value: match[1].slice(1, -1).replace(/''/g, "'") });
    else if (match[2]) tokens.push({ type: "num", value: Number(match[2]) });
    else if (match[3]) tokens.push({ type: "op", value: match[3] });
    else if (match[4]) tokens.push({ type: "id", value: match[4] });
  }
  return tokens;
}

const fold = (value) => (typeof value === "string" ? value.toLowerCase() : value);
function looseEqual(a, b) {
  if (typeof a === "string" && typeof b === "string") return fold(a) === fold(b);
  if (typeof a === "number" || typeof b === "number") return Number(a ?? 0) === Number(b ?? 0);
  return a === b;
}
const truthy = (value) => !(value === false || value === null || value === undefined || value === 0 || value === "" || Number.isNaN(value));
const asString = (value) => (value === null || value === undefined ? "" : String(value));

const FUNCTIONS = {
  contains(haystack, needle) {
    if (Array.isArray(haystack)) return haystack.some((item) => looseEqual(item, needle));
    return fold(asString(haystack)).includes(fold(asString(needle)));
  },
  startsWith: (value, prefix) => fold(asString(value)).startsWith(fold(asString(prefix))),
  fromJSON: (text) => JSON.parse(text),
  format: (template, ...args) => template.replace(/\{(\d+)\}/g, (_, n) => asString(args[Number(n)])),
};

function evaluate(source, context, asBoolean = true) {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const take = (value) => {
    const token = tokens[position++];
    if (value !== undefined && token?.value !== value) throw new Error(`expected ${value}`);
    return token;
  };
  const or = () => {
    let left = and();
    while (peek()?.value === "||") { take(); const right = and(); left = truthy(left) ? left : right; }
    return left;
  };
  const and = () => {
    let left = equality();
    while (peek()?.value === "&&") { take(); const right = equality(); left = truthy(left) ? right : left; }
    return left;
  };
  const equality = () => {
    let left = unary();
    while (peek()?.value === "==" || peek()?.value === "!=") {
      const op = take().value;
      const right = unary();
      left = op === "==" ? looseEqual(left, right) : !looseEqual(left, right);
    }
    return left;
  };
  const unary = () => (peek()?.value === "!" ? (take(), !truthy(unary())) : primary());
  const primary = () => {
    const token = take();
    if (token.type === "str" || token.type === "num") return token.value;
    if (token.value === "(") { const value = or(); take(")"); return value; }
    if (token.type !== "id") throw new Error(`unexpected ${token.value}`);
    if (peek()?.value === "(") {
      take("(");
      const args = [];
      while (peek()?.value !== ")") { args.push(or()); if (peek()?.value === ",") take(","); }
      take(")");
      return FUNCTIONS[token.value](...args);
    }
    if (token.value === "true" || token.value === "false") return token.value === "true";
    if (token.value === "null") return null;
    let value = context[token.value] ?? null;
    while (peek()?.value === ".") { take("."); const key = take().value; value = value?.[key] ?? null; }
    return value;
  };
  const result = or();
  assert.equal(position, tokens.length, "gate expression was not fully parsed");
  return asBoolean ? truthy(result) : result;
}

test("concurrency supersedes PR and feature pushes without discarding release runs", () => {
  const group = workflow.match(/\n  group: >-\n([\s\S]+?)\n  cancel-in-progress:/)[1]
    .split("\n").map((line) => line.trim()).join(" ");
  const cancel = workflow.match(/\n  cancel-in-progress: \$\{\{ (.+) \}\}/)[1];
  const key = (github) => group.replace(/\$\{\{(.*?)\}\}/g, (_, expression) =>
    asString(evaluate(expression, { github }, false)));
  const canCancel = (github) => evaluate(cancel, { github });
  const push = (branch, run_id) => ({ event_name: "push", ref: `refs/heads/${branch}`, run_id });
  const release = push("release/native-0.1.10", 1);
  assert.equal(canCancel(release), false);
  assert.notEqual(key(release), key({ ...release, run_id: 2 }));

  const feature = push("feat/assemblyai-current", 1);
  assert.equal(canCancel(feature), true);
  assert.equal(key(feature), key({ ...feature, run_id: 2 }));

  const pr = {
    event_name: "pull_request", event: { pull_request: { number: 12 } },
    triggering_actor: "nullStack65", run_id: 1,
  };
  assert.equal(canCancel(pr), true);
  assert.equal(key(pr), key({ ...pr, run_id: 2 }));
  assert.notEqual(key(pr), key({ ...pr, triggering_actor: "review-bot[bot]" }));
  assert.notEqual(key(pr), key({ ...pr, event: { pull_request: { number: 13 } } }));
});

const BOT = { login: "closura-t3code-upstream-sync[bot]", id: 360477638, type: "Bot" };
const REPO = "nullStack65/t3code";
const SYNC_BODY = "Merges pingdotgg/t3code main into the release line.\n\nDeploy: none\n";

// Author, repository and identity fields copied from the disposable proof PR #194.
function prEvent(overrides = {}) {
  const pr = {
    draft: false,
    user: { login: BOT.login, id: BOT.id },
    head: { ref: "sync/upstream-2026-11-24", repo: { full_name: REPO } },
    base: { ref: "release/native-0.1.10" },
    body: SYNC_BODY,
    ...overrides.pull_request,
  };
  return {
    github: {
      repository_id: "1372173214",
      repository: REPO,
      event_name: "pull_request",
      ref: "refs/pull/194/merge",
      actor: BOT.login,
      actor_id: String(BOT.id),
      triggering_actor: BOT.login,
      ...overrides.github,
      event: { pull_request: pr },
    },
  };
}

function admitted(context) {
  const results = WORKERS.map((job) => evaluate(gateOf(job), context));
  assert.ok(results.every((value) => value === results[0]), `workers disagree: ${results}`);
  return results[0];
}

test("the upstream-sync App is admitted on its exact proposal shape", () => {
  assert.equal(admitted(prEvent()), true);
});

test("PR #194 as opened is not admitted: proof branch name and no Deploy line", () => {
  const pr194 = prEvent({
    pull_request: {
      head: { ref: "clo1110/disposable-ci-proof-20261124", repo: { full_name: REPO } },
      body: "Throwaway draft opened by the closura-t3code-upstream-sync App to prove that an App-opened proposal triggers the required checks (CLO-1110). It will be closed unmerged.",
    },
  });
  assert.equal(admitted(pr194), false);
});

const rejected = {
  "a fork head": { pull_request: { head: { ref: "sync/upstream-2026-11-24", repo: { full_name: "someone/t3code" } } } },
  "a head repository that is missing": { pull_request: { head: { ref: "sync/upstream-2026-11-24", repo: null } } },
  "a branch without the sync prefix": { pull_request: { head: { ref: "clo1110/disposable-ci-proof-20261124", repo: { full_name: REPO } } } },
  "the sync prefix only in the middle of the branch": { pull_request: { head: { ref: "feature/sync/upstream-x", repo: { full_name: REPO } } } },
  "a base other than the release line": { pull_request: { base: { ref: "feat/assemblyai-current" } } },
  "Deploy: fleet": { pull_request: { body: "Upstream sync.\n\nDeploy: fleet\n" } },
  "both Deploy lines": { pull_request: { body: "Deploy: none\nDeploy: fleet\n" } },
  "a Deploy value that only starts with none": { pull_request: { body: "Deploy: nonesuch\n" } },
  "Deploy: none mid-line": { pull_request: { body: "We say Deploy: none here\n" } },
  "an empty body": { pull_request: { body: null } },
  "a draft": { pull_request: { draft: true } },
  "a different bot": {
    pull_request: { user: { login: "dependabot[bot]", id: 49699333 } },
    github: { actor: "dependabot[bot]", actor_id: "49699333", triggering_actor: "dependabot[bot]" },
  },
  "the App's login with another id": { pull_request: { user: { login: BOT.login, id: 1 } } },
  "the App's id with another login": { pull_request: { user: { login: "closura-t3code-upstream-sync", id: BOT.id } } },
  "a lookalike login": {
    pull_request: { user: { login: "closura-t3code-upstream-sync-evil[bot]", id: BOT.id } },
    github: { actor: "closura-t3code-upstream-sync-evil[bot]", triggering_actor: "closura-t3code-upstream-sync-evil[bot]" },
  },
  "another actor editing the App's PR": { github: { actor: "coderabbitai[bot]", actor_id: "136622811", triggering_actor: "coderabbitai[bot]" } },
  "the App's login with another actor id": { github: { actor_id: "1" } },
  "a re-run triggered by someone else": { github: { triggering_actor: "someone" } },
  "another repository": { github: { repository_id: "1" } },
};
for (const [name, overrides] of Object.entries(rejected)) {
  test(`the App gate rejects ${name}`, () => {
    assert.equal(admitted(prEvent(overrides)), false);
  });
}

test("founder pull requests are admitted as before", () => {
  const founder = {
    pull_request: { user: { login: "nullStack65", id: 112618179 }, head: { ref: "fix/anything", repo: { full_name: REPO } }, body: "Deploy: fleet\n" },
    github: { actor: "nullStack65", actor_id: "112618179", triggering_actor: "nullStack65" },
  };
  assert.equal(admitted(prEvent(founder)), true);
  assert.equal(admitted(prEvent({ ...founder, pull_request: { ...founder.pull_request, head: { ref: "x", repo: { full_name: "fork/t3code" } } } })), false);
});

test("push and manual runs keep the founder-only release-branch path", () => {
  const push = (actor, ref) => ({
    github: { repository_id: "1372173214", repository: REPO, event_name: "push", ref, actor, actor_id: "0", triggering_actor: actor, event: {} },
  });
  assert.equal(admitted(push("nullStack65", "refs/heads/release/native-0.1.10")), true);
  assert.equal(admitted(push("jeffreysmithclosura", "refs/heads/feat/assemblyai-current")), true);
  assert.equal(admitted(push(BOT.login, "refs/heads/release/native-0.1.10")), false);
  assert.equal(admitted(push("nullStack65", "refs/heads/sync/upstream-2026-11-24")), false);
});

// The `if:` clause is a prefilter; the first step of each worker parses the
// Deploy line exactly as closura-deploy-line.yml does. Run that real script.
const { spawnSync } = require("node:child_process");
const STEP = "Require Deploy none from the upstream-sync App";

function deployStepOf(job) {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  const steps = workflow.indexOf("\n    steps:\n", start);
  const first = workflow.slice(steps).match(/\n      - name: (.*)\n[\s\S]*?\n        run: \|\n((?:          .*\n|\n)*)/);
  assert.equal(first?.[1], STEP, `${job} must run the Deploy-line step first, before checkout`);
  return first[2].split("\n").map((line) => line.slice(10)).join("\n");
}

function stepPasses(body) {
  const scripts = WORKERS.map(deployStepOf);
  assert.ok(scripts.every((script) => script === scripts[0]), "workers run different Deploy-line steps");
  const run = spawnSync("bash", ["-c", scripts[0]], { env: { PATH: process.env.PATH, PR_BODY: body ?? "" } });
  return run.status === 0;
}

const admittedEndToEnd = (body) => admitted(prEvent({ pull_request: { body } })) && stepPasses(body);

test("the App's sync body passes the gate and the Deploy-line step", () => {
  assert.equal(admittedEndToEnd(SYNC_BODY), true);
  assert.equal(admittedEndToEnd("Deploy: none"), true);
});

const smuggled = {
  "a fenced Deploy: none with Deploy:fleet": "```\nDeploy: none\n```\nDeploy:fleet\n",
  "lowercase deploy: none with Deploy:fleet": "deploy: none\nDeploy:fleet\n",
  "a tab before fleet": "deploy: none\nDeploy:\tfleet\n",
  "Deploy: none only inside a fence": "~~~\nDeploy: none\n~~~\n",
  "two Deploy: none lines": "Deploy: none\nDeploy: none\n",
};
for (const [name, body] of Object.entries(smuggled)) {
  test(`the App is rejected for ${name}`, () => {
    assert.equal(admittedEndToEnd(body), false);
  });
}

test("the Deploy-line step accepts the forms the deploy-line job reads as none", () => {
  assert.equal(stepPasses("Deploy:none\r\n"), true);
  assert.equal(stepPasses("Deploy:   none  \n"), true);
  assert.equal(stepPasses("Deploy: fleet\n"), false);
  assert.equal(stepPasses(""), false);
});
