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
