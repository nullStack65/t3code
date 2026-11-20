const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { REQUIRED_TESTS, checkCoverage } = require("./arc-ci-coverage.cjs");

const root = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(
  path.join(root, ".github/workflows/closura-arc-ci.yml"),
  "utf8",
);

test("the parallel workers cover every test the serial job ran", () => {
  assert.deepEqual(checkCoverage(workflow), []);
});

test("renaming the aggregator or dropping a test fails the check", () => {
  const renamed = workflow.replace(
    "name: Voice + founder inbox (Linux ARC)",
    "name: Voice and inbox",
  );
  assert.ok(checkCoverage(renamed).some((problem) => problem.startsWith("required check")));

  const dropped = workflow.replace(`            ${REQUIRED_TESTS[0]} \\\n`, "");
  assert.ok(checkCoverage(dropped).some((problem) => problem.includes(REQUIRED_TESTS[0])));
});

test("a test that only appears in dead code does not count as run", () => {
  const buried = workflow.replace(
    `            ${REQUIRED_TESTS[0]} \\\n`,
    `          if false; then echo ${REQUIRED_TESTS[0]}; fi\n`,
  );
  assert.ok(checkCoverage(buried).some((problem) => problem.includes(REQUIRED_TESTS[0])));
});

test("an aggregator that runs on cancellation fails the check", () => {
  const always = workflow.replace("if: ${{ !cancelled() }}", "if: always()");
  assert.ok(
    checkCoverage(always).some((problem) => problem.includes("cancelled")),
  );
});
