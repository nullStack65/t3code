// GitHub-hosted runners are forbidden. Every job in every workflow must run on
// the repository's self-hosted ARC scale set, and the retired hosted
// "emergency burst" switch (CI_BURST_HOSTED) must not return. Burst capacity is
// Hetzner ARC nodes only. Runs from the ARC CI workflow.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const dir = path.resolve(__dirname, "../workflows");
const ARC = "t3code-ci-arc";
const files = fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));

function violations(name, text) {
  const problems = [];
  if (/ci_burst_hosted/i.test(text)) problems.push(`${name}: references CI_BURST_HOSTED`);
  for (const match of text.matchAll(/^[ \t-]*runs-on:[ \t]*(.*?)[ \t]*(?:#.*)?$/gm)) {
    if (match[1] !== ARC) problems.push(`${name}: runs-on must be exactly ${ARC}, got ${match[1] || "(multi-line)"}`);
  }
  return problems;
}

test("no workflow can run on a GitHub-hosted runner", () => {
  assert.ok(files.length > 0);
  const problems = files.flatMap((name) => violations(name, fs.readFileSync(path.join(dir, name), "utf8")));
  assert.deepEqual(problems, []);
});

test("the check rejects hosted labels, expressions and the retired switch", () => {
  for (const bad of [
    "    runs-on: ubuntu-latest\n",
    "    runs-on: ubuntu-24.04\n",
    "    runs-on: macos-14\n",
    "    runs-on: blacksmith-8vcpu-ubuntu-2404\n",
    "    runs-on: [self-hosted, linux]\n",
    "    runs-on: ${{ vars.CI_BURST_HOSTED == 'on' && 'ubuntu-latest' || 't3code-ci-arc' }}\n",
    "    runs-on: t3code-ci-arc\n    # CI_BURST_HOSTED\n",
  ]) {
    assert.ok(violations("fixture.yml", bad).length > 0, bad);
  }
  assert.deepEqual(violations("fixture.yml", "    runs-on: t3code-ci-arc\n"), []);
});
