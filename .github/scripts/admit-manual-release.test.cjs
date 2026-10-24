const assert = require("node:assert/strict");
const test = require("node:test");
const { admitManualRelease, assertReviewedReleaseSource } = require("./admit-manual-release.cjs");
const workflow = "a".repeat(40);
const source = "b".repeat(40);
function fixture() {
  return {
    context: {
      eventName: "workflow_dispatch",
      payload: {
        repository: {
          full_name: "nullStack65/t3code",
          owner: { id: 112618179 },
          default_branch: "main",
        },
      },
      ref: "refs/heads/main",
      actor: "nullStack65",
      sha: workflow,
    },
    env: {
      GITHUB_ACTOR_ID: "112618179",
      GITHUB_TRIGGERING_ACTOR: "nullStack65",
      GITHUB_RUN_ATTEMPT: "1",
      REVIEWED_SOURCE_SHA: source,
      REVIEWED_WORKFLOW_SHA: workflow,
      WORKFLOW_SHA: workflow,
    },
    github: {
      rest: { repos: { getBranch: async () => ({ data: { commit: { sha: workflow } } }) } },
    },
  };
}
test("admits reviewed source separately from the exact current workflow", async () => {
  assert.equal(await admitManualRelease(fixture()), source);
  assertReviewedReleaseSource(source, source);
});
for (const [name, change] of [
  ["scheduled release", (f) => (f.context.eventName = "schedule")],
  ["tag push", (f) => (f.context.eventName = "push")],
  ["foreign repository", (f) => (f.context.payload.repository.full_name = "other/t3code")],
  ["foreign owner", (f) => (f.context.payload.repository.owner.id = 1)],
  ["different default", (f) => (f.context.payload.repository.default_branch = "other")],
  ["branch dispatch", (f) => (f.context.ref = "refs/heads/feature")],
  ["other actor", (f) => (f.context.actor = "other")],
  ["actor id mismatch", (f) => (f.env.GITHUB_ACTOR_ID = "1")],
  ["other triggering actor", (f) => (f.env.GITHUB_TRIGGERING_ACTOR = "other")],
  ["rerun", (f) => (f.env.GITHUB_RUN_ATTEMPT = "2")],
  ["missing source", (f) => delete f.env.REVIEWED_SOURCE_SHA],
  ["short source", (f) => (f.env.REVIEWED_SOURCE_SHA = "abc")],
  ["wrong workflow", (f) => (f.env.REVIEWED_WORKFLOW_SHA = source)],
  ["wrong executable workflow", (f) => (f.env.WORKFLOW_SHA = source)],
  ["version override", (f) => (f.env.VERSION_OVERRIDE = "1.2.3")],
  [
    "advanced main",
    (f) => (f.github.rest.repos.getBranch = async () => ({ data: { commit: { sha: source } } })),
  ],
  [
    "unreadable main",
    (f) =>
      (f.github.rest.repos.getBranch = async () => {
        throw new Error("unavailable");
      }),
  ],
])
  test(`rejects ${name}`, async () => {
    const f = fixture();
    change(f);
    await assert.rejects(admitManualRelease(f));
  });
test("rejects a changed resolved nightly or mobile source", () => {
  assert.throws(() => assertReviewedReleaseSource(workflow, source));
});
