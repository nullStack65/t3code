// Adapted from the native release branch's ARC-only runner guard.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const test = require("node:test");

const { parse } = createRequire(path.resolve(__dirname, "../../apps/server/package.json"))("yaml");
const workflows = path.resolve(__dirname, "../workflows");
const files = fs.readdirSync(workflows).filter((file) => /\.ya?ml$/.test(file));
const arc = "t3code-ci-arc";
const desktopRunner = [
  "${{ fromJSON(",
  `inputs.platform == 'linux' && '["${arc}"]' ||`,
  `inputs.platform == 'mac' && inputs.arch == 'arm64' && '["self-hosted","macOS","ARM64"]' ||`,
  `inputs.platform == 'mac' && '["self-hosted","macOS","X64"]' ||`,
  `inputs.arch == 'arm64' && '["self-hosted","Windows","ARM64"]' ||`,
  `'["self-hosted","Windows","X64"]'`,
  ") }}",
].join(" ");

function violations(file, text) {
  const problems = [];
  if (/ci_burst_hosted/i.test(text)) problems.push(`${file}: references the retired burst switch`);
  const { jobs } = parse(text);
  assert.ok(jobs && Object.keys(jobs).length > 0, `${file}: no jobs`);
  for (const [name, job] of Object.entries(jobs)) {
    if (job.uses) {
      const local = /^\.\/\.github\/workflows\/([^/]+\.ya?ml)$/.exec(job.uses);
      if (!local || !files.includes(local[1])) {
        problems.push(`${file}:${name}: reusable workflow must be local and covered by this check`);
      }
      continue;
    }
    const runner = job["runs-on"];
    if (runner === arc) continue;
    if (Array.isArray(runner) && runner[0] === "self-hosted") {
      if (runner.length === 2 && runner[1] === "macOS") continue;
      if (runner.length === 3 && runner[1] === "Windows" && runner[2] === "X64") continue;
    }
    if (
      file === "release-desktop.yml" &&
      name === "build" &&
      typeof runner === "string" &&
      runner.replace(/\s+/g, " ").trim() === desktopRunner
    )
      continue;
    problems.push(`${file}:${name}: unsupported runner ${JSON.stringify(runner)}`);
  }
  return problems;
}

test("every workflow routes only to the T3 ARC scale set or a self-hosted native runner", () => {
  assert.ok(files.length > 0);
  assert.deepEqual(
    files.flatMap((file) => violations(file, fs.readFileSync(path.join(workflows, file), "utf8"))),
    [],
  );
});

test("the runner guard rejects hosted labels, variable selectors and remote reusable workflows", () => {
  for (const job of [
    "runs-on: ubuntu-latest",
    "runs-on: macos-14",
    "runs-on: windows-11-arm",
    "runs-on: blacksmith-8vcpu-ubuntu-2404",
    "runs-on: [self-hosted, ubuntu-latest]",
    "runs-on: {group: custom, labels: macos-latest}",
    "runs-on: ${{ inputs.runner }}",
    "uses: other/repo/.github/workflows/ci.yml@main",
  ]) {
    assert.ok(violations("fixture.yml", `jobs:\n  check:\n    ${job}\n`).length > 0, job);
  }
  assert.deepEqual(violations("fixture.yml", `jobs:\n  check:\n    runs-on: ${arc}\n`), []);
});

test("mobile native static analysis only admits trusted manual runs on a self-hosted Mac", () => {
  const ci = parse(fs.readFileSync(path.join(workflows, "ci.yml"), "utf8"));
  assert.ok(Object.hasOwn(ci.on, "workflow_dispatch"));
  const job = ci.jobs.mobile_native_static_analysis;
  assert.match(job.if, /&&\s+\(github\.event_name == 'workflow_dispatch'\)$/);
  assert.deepEqual(job["runs-on"], ["self-hosted", "macOS"]);
});
