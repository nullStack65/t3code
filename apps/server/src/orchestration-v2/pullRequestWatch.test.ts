import type {
  PullRequestCheck,
  PullRequestComment,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { ThreadPullRequestWatch as WatchSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { pullRequestChecksFromContexts } from "@t3tools/source-control-github/server/gitHubPullRequestJson";

import {
  PULL_REQUEST_WATCH_WAKE_LIMIT,
  evaluatePullRequestWatch,
  pullRequestWatchMessage,
} from "./pullRequestWatch.ts";

const STARTED = "2026-10-02T12:00:00.000Z";
const decodeWatch = Schema.decodeUnknownSync(WatchSchema);

const watch = (overrides: Partial<ThreadPullRequestWatch> = {}): ThreadPullRequestWatch => ({
  startedAt: STARTED,
  headSha: null,
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: STARTED,
  remarkIds: [],
  conflicting: false,
  wakes: 0,
  ...overrides,
});

const check = (name: string, status: PullRequestCheck["status"]): PullRequestCheck => ({
  name,
  status,
  description: null,
  url: `https://ci.example/${name}`,
});

type Detail = Parameters<typeof evaluatePullRequestWatch>[1];

const detail = (overrides: Partial<Detail> = {}): Detail => ({
  headSha: "aaaaaaaaaa",
  checks: [check("lint", "success"), check("test", "pending")],
  mergeability: "mergeable",
  viewer: "agent-user",
  author: { login: "agent-user", name: null, avatarUrl: null },
  ...overrides,
});

const remark = (
  login: string,
  createdAt: string,
  body = "Please rename this.",
): PullRequestComment => ({
  id: `${login}-${createdAt}`,
  kind: "review-comment",
  author: { login, name: null, avatarUrl: null },
  body,
  createdAt,
  url: `https://github.com/o/r/pull/1#${login}`,
  path: "src/index.ts",
  reviewState: null,
});

const noRemarks: ReadonlyArray<PullRequestComment> = [];

describe("terminal completion news", () => {
  const job = (
    id: string,
    status: PullRequestCheck["status"] = "success",
    attempt: string | null = "1",
  ): PullRequestCheck => ({
    ...check("build", status),
    identity: { id, ...(attempt === null ? {} : { attempt }) },
  });
  const snapshot = (...jobs: ReadonlyArray<PullRequestCheck>): Detail =>
    detail({
      checks: [
        { ...check("required", "success"), required: true },
        ...jobs,
        check("advisory", "pending"),
      ],
    });
  const baseline = () =>
    evaluatePullRequestWatch(watch(), snapshot(job("run-1", "pending")), noRemarks).next;
  const completed = (report: ReturnType<typeof evaluatePullRequestWatch>) =>
    report.changes.filter((change) => change.kind === "checks-completed");

  it.each(["run-1", "run-2"])("reports late success with optional work pending: %s", (id) => {
    const result = evaluatePullRequestWatch(baseline(), snapshot(job(id)), noRemarks);
    assert.deepEqual(result.changes, [{ kind: "checks-completed", completed: [job(id)] }]);
    assert.deepEqual(
      evaluatePullRequestWatch(result.next, snapshot(job(id)), noRemarks).changes,
      [],
    );
    const message = pullRequestWatchMessage({
      number: 12,
      url: "https://github.com/o/r/pull/12",
      baseBranch: "main",
      headSha: result.next.headSha,
      report: result,
    });
    assert.include(message.text, "build (success)");
    assert.notInclude(message.text, "All ");
    assert.equal(message.notification.outcome, "updated");
  });

  it("coalesces native results, retains run/attempt/status history across persistence and reconnect", () => {
    const both = snapshot(job("run-1"), { ...job("other"), name: "test" });
    const first = evaluatePullRequestWatch(baseline(), both, noRemarks);
    assert.equal(completed(first).length, 1);
    assert.equal(completed(first)[0]?.completed.length, 2);
    const saved = decodeWatch(JSON.parse(JSON.stringify(first.next)));
    assert.deepEqual(saved, first.next);
    const empty = evaluatePullRequestWatch(saved, detail({ checks: [] }), null);
    assert.deepEqual(empty.next.terminalCheckRuns, saved.terminalCheckRuns);
    assert.deepEqual(evaluatePullRequestWatch(empty.next, both, noRemarks).changes, []);
    const retry = evaluatePullRequestWatch(
      saved,
      snapshot(job("run-1", "success", "2")),
      noRemarks,
    );
    assert.equal(completed(retry).length, 1);
    assert.deepEqual(evaluatePullRequestWatch(retry.next, both, noRemarks).changes, []);
    const renamed = snapshot({ ...job("run-1", "success", "2"), name: "renamed" });
    assert.deepEqual(evaluatePullRequestWatch(retry.next, renamed, noRemarks).changes, []);
  });

  it("keeps failure/cancelled identity semantics and reports recovery as completion news once", () => {
    let state = baseline();
    for (const status of ["failure", "cancelled", "action-required"] as const) {
      const result = evaluatePullRequestWatch(state, snapshot(job("run-1", status)), noRemarks);
      assert.equal(result.changes.length, status === "failure" ? 1 : 0);
      assert.equal(completed(result).length, 0);
      state = result.next;
    }
    const recovery = evaluatePullRequestWatch(state, snapshot(job("run-1")), noRemarks);
    assert.equal(completed(recovery).length, 1);
    const pending = evaluatePullRequestWatch(
      recovery.next,
      snapshot(job("run-1", "pending")),
      noRemarks,
    );
    assert.deepEqual(
      evaluatePullRequestWatch(pending.next, snapshot(job("run-1")), noRemarks).changes,
      [],
    );
  });

  it("baselines initial/legacy terminals after an empty fetch and resets for a different head/watch", () => {
    const legacy = watch({ headSha: "aaaaaaaaaa", passed: true, passedChecks: ["required"] });
    const empty = evaluatePullRequestWatch(legacy, detail({ checks: [] }), null);
    assert.isUndefined(empty.next.terminalCheckRuns);
    const current = snapshot(job("run-1"));
    const hydrated = evaluatePullRequestWatch(empty.next, current, noRemarks);
    assert.deepEqual(hydrated.changes, []);
    assert.isDefined(hydrated.next.terminalCheckRuns);
    assert.equal(completed(evaluatePullRequestWatch(watch(), current, noRemarks)).length, 0);
    assert.equal(
      completed(
        evaluatePullRequestWatch(hydrated.next, { ...current, headSha: "new-head" }, noRemarks),
      ).length,
      0,
    );
    assert.equal(
      completed(evaluatePullRequestWatch(hydrated.next, snapshot(job("run-2")), noRemarks)).length,
      1,
    );
  });

  it("baselines incomplete identities without fabricating runs or replaying learned attempt tokens", () => {
    const unknown = { ...check("build", "success"), url: "https://ci.example/not-an-id" };
    const first = evaluatePullRequestWatch(baseline(), snapshot(unknown), noRemarks);
    assert.deepEqual(first.changes, []);
    const learned = evaluatePullRequestWatch(
      first.next,
      snapshot(job("run-1", "success", null)),
      noRemarks,
    );
    assert.deepEqual(learned.changes, []);
    const attempt = evaluatePullRequestWatch(learned.next, snapshot(job("run-1")), noRemarks);
    assert.deepEqual(attempt.changes, []);
    const lost = evaluatePullRequestWatch(
      attempt.next,
      snapshot(job("run-1", "success", null)),
      noRemarks,
    );
    assert.deepEqual(lost.changes, []);
    assert.equal(
      completed(
        evaluatePullRequestWatch(lost.next, snapshot(job("run-1", "success", "2")), noRemarks),
      ).length,
      1,
    );
  });
});

describe("evaluatePullRequestWatch", () => {
  const run = (id: string, attempt = "1"): PullRequestCheck => ({
    ...check("Dev CI", "failure"),
    identity: { id, attempt },
  });
  const failing = (id: string, attempt = "1") => detail({ checks: [run(id, attempt)] });

  it("reports a new failed run on the same head when pending fell between sweeps", () => {
    const first = evaluatePullRequestWatch(watch(), failing("run-1"), noRemarks);
    const second = evaluatePullRequestWatch(first.next, failing("run-2"), noRemarks);
    assert.deepEqual(second.changes, [{ kind: "checks-failed", failed: [run("run-2")] }]);
    assert.deepEqual(
      evaluatePullRequestWatch(second.next, failing("run-2"), noRemarks).changes,
      [],
    );
  });

  it("distinguishes attempts of a reused provider id without a pending observation", () => {
    const first = evaluatePullRequestWatch(watch(), failing("run", "attempt-1"), noRemarks);
    const retry = evaluatePullRequestWatch(first.next, failing("run", "attempt-2"), noRemarks);
    assert.equal(retry.changes[0]?.kind, "checks-failed");
    assert.deepEqual(
      evaluatePullRequestWatch(retry.next, failing("run", "attempt-2"), noRemarks).changes,
      [],
    );
  });

  it("treats a missing attempt token as unverified, then baselines its first known value", () => {
    const incomplete = detail({ checks: [{ ...run("run"), identity: { id: "run" } }] });
    const first = evaluatePullRequestWatch(watch(), incomplete, noRemarks);
    const learned = evaluatePullRequestWatch(first.next, failing("run", "1"), noRemarks);
    assert.deepEqual(learned.changes, []);
    const lost = evaluatePullRequestWatch(learned.next, incomplete, noRemarks);
    assert.deepEqual(lost.changes, []);
    assert.deepEqual(lost.next.failedCheckRuns, learned.next.failedCheckRuns);
    assert.equal(
      evaluatePullRequestWatch(lost.next, failing("run", "2"), noRemarks).changes[0]?.kind,
      "checks-failed",
    );
  });

  it("does not replay a GitHub failure when its unset start time becomes known", () => {
    const providerDetail = (startedAt: string) =>
      detail({
        checks: pullRequestChecksFromContexts([
          {
            __typename: "CheckRun",
            id: "CR_1",
            name: "Dev CI",
            status: "COMPLETED",
            conclusion: "FAILURE",
            startedAt,
          },
        ]).checks,
      });
    const unset = providerDetail("0001-01-01T00:00:00Z");
    assert.deepEqual(unset.checks[0]?.identity, { id: "github:CheckRun:CR_1" });
    const first = evaluatePullRequestWatch(watch(), unset, noRemarks);
    const known = evaluatePullRequestWatch(
      first.next,
      providerDetail("2026-10-16T12:00:00Z"),
      noRemarks,
    );
    assert.deepEqual(known.changes, []);
    assert.equal(
      evaluatePullRequestWatch(known.next, providerDetail("2026-10-16T12:05:00Z"), noRemarks)
        .changes[0]?.kind,
      "checks-failed",
    );
  });

  it("retains reported identities when older runs resurface after pending or an absent row", () => {
    const first = evaluatePullRequestWatch(watch(), failing("run-1"), noRemarks);
    const second = evaluatePullRequestWatch(first.next, failing("run-2"), noRemarks);
    const pending = evaluatePullRequestWatch(
      second.next,
      detail({ checks: [{ ...run("run-2"), status: "pending" }] }),
      noRemarks,
    );
    assert.deepEqual(
      evaluatePullRequestWatch(pending.next, failing("run-1"), noRemarks).changes,
      [],
    );
    const absent = evaluatePullRequestWatch(
      second.next,
      detail({ checks: [check("other", "pending")] }),
      noRemarks,
    );
    assert.deepEqual(
      evaluatePullRequestWatch(absent.next, failing("run-2"), noRemarks).changes,
      [],
    );
  });

  it("deduplicates the same run even if its display name or failed conclusion changes", () => {
    const first = evaluatePullRequestWatch(watch(), failing("run"), noRemarks);
    const renamed = detail({
      checks: [{ ...run("run"), name: "workflow / Dev CI", status: "cancelled" }],
    });
    assert.deepEqual(evaluatePullRequestWatch(first.next, renamed, noRemarks).changes, []);
  });

  it("keeps identities across a persisted restart and reconnect, then reports a new run", () => {
    const first = evaluatePullRequestWatch(watch(), failing("run-1"), noRemarks);
    const persisted = decodeWatch(JSON.parse(JSON.stringify(first.next)));
    assert.deepEqual(persisted.failedCheckRuns, first.next.failedCheckRuns);
    assert.deepEqual(evaluatePullRequestWatch(persisted, failing("run-1"), noRemarks).changes, []);
    const offline = evaluatePullRequestWatch(persisted, detail({ checks: [] }), null);
    assert.deepEqual(
      evaluatePullRequestWatch(offline.next, failing("run-1"), noRemarks).changes,
      [],
    );
    assert.equal(
      evaluatePullRequestWatch(offline.next, failing("run-2"), noRemarks).changes[0]?.kind,
      "checks-failed",
    );
  });

  it("baselines legacy names once without replay, while new names still wake", () => {
    const legacy = watch({ headSha: "aaaaaaaaaa", failedChecks: ["Dev CI"] });
    const upgraded = evaluatePullRequestWatch(legacy, failing("run-1"), noRemarks);
    assert.deepEqual(upgraded.changes, []);
    assert.equal(upgraded.next.failedCheckRuns?.length, 1);
    assert.equal(
      evaluatePullRequestWatch(upgraded.next, failing("run-2"), noRemarks).changes[0]?.kind,
      "checks-failed",
    );
    const newName = detail({ checks: [{ ...run("new"), name: "new check" }] });
    assert.equal(
      evaluatePullRequestWatch(legacy, newName, noRemarks).changes[0]?.kind,
      "checks-failed",
    );
  });

  it("does not consume a legacy baseline during a transient failed check fetch", () => {
    const legacy = watch({ headSha: "aaaaaaaaaa", failedChecks: ["Dev CI"] });
    const failedFetch = evaluatePullRequestWatch(legacy, detail({ checks: [] }), null);
    assert.isUndefined(failedFetch.next.failedCheckRuns);
    assert.deepEqual(
      evaluatePullRequestWatch(failedFetch.next, failing("run-1"), noRemarks).changes,
      [],
    );
  });

  it("does not invent identity from URLs when the provider cannot identify a run", () => {
    const first = evaluatePullRequestWatch(
      watch(),
      detail({ checks: [check("Dev CI", "failure")] }),
      noRemarks,
    );
    assert.deepEqual(first.next.failedCheckRuns, []);
    const changedUrl = detail({
      checks: [{ ...check("Dev CI", "failure"), url: "https://example.invalid/new" }],
    });
    assert.deepEqual(evaluatePullRequestWatch(first.next, changedUrl, noRemarks).changes, []);
    const identified = evaluatePullRequestWatch(first.next, failing("now-known"), noRemarks);
    assert.deepEqual(identified.changes, []);
    assert.equal(
      evaluatePullRequestWatch(identified.next, failing("new-run"), noRemarks).changes[0]?.kind,
      "checks-failed",
    );
  });

  it("scopes run history to each watch and head", () => {
    const first = evaluatePullRequestWatch(watch(), failing("run"), noRemarks);
    assert.equal(
      evaluatePullRequestWatch(watch(), failing("run"), noRemarks).changes[0]?.kind,
      "checks-failed",
    );
    const pushed = { ...failing("run"), headSha: "bbbbbbbbbb" };
    assert.equal(
      evaluatePullRequestWatch(first.next, pushed, noRemarks).changes[0]?.kind,
      "checks-failed",
    );
  });

  it("reports each failure at once, even while another check never finishes", () => {
    const bot = check("CodeRabbit", "pending");
    const first = detail({ checks: [check("lint", "failure"), check("test", "pending"), bot] });
    const lint = evaluatePullRequestWatch(watch(), first, noRemarks);
    assert.deepEqual(lint.changes, [{ kind: "checks-failed", failed: [check("lint", "failure")] }]);
    assert.deepEqual(evaluatePullRequestWatch(lint.next, first, noRemarks).changes, []);

    // A different job failing later is news of its own.
    const second = detail({ checks: [check("lint", "failure"), check("test", "failure"), bot] });
    const test = evaluatePullRequestWatch(lint.next, second, noRemarks);
    assert.deepEqual(test.changes, [{ kind: "checks-failed", failed: [check("test", "failure")] }]);

    // A rerun leaves the list while it runs, so failing again is reported again.
    const rerun = evaluatePullRequestWatch(test.next, first, noRemarks);
    assert.equal(evaluatePullRequestWatch(rerun.next, second, noRemarks).changes.length, 1);

    // A push reports its failures, even ones that failed between two passes.
    const pushed = detail({ ...second, headSha: "bbbbbbbbbb" });
    assert.equal(evaluatePullRequestWatch(test.next, pushed, noRemarks).changes.length, 1);
  });

  it("reports passed once the required checks pass, whatever the others do", () => {
    const required = (name: string, status: PullRequestCheck["status"]) => ({
      ...check(name, status),
      required: true,
    });
    const green = detail({
      checks: [required("test", "success"), required("lint", "success"), check("bot", "pending")],
    });
    const passed = evaluatePullRequestWatch(watch(), green, noRemarks);
    assert.deepEqual(passed.changes, [{ kind: "checks-passed", count: 2, required: true }]);
    assert.deepEqual(evaluatePullRequestWatch(passed.next, green, noRemarks).changes, []);

    // Where nothing is marked required, every check has to pass.
    const plain = detail({ checks: [check("test", "success"), check("bot", "pending")] });
    assert.deepEqual(evaluatePullRequestWatch(watch(), plain, noRemarks).changes, []);
  });

  it("reports passed again when a required check shows up already passed", () => {
    const required = (name: string, status: PullRequestCheck["status"]) => ({
      ...check(name, status),
      required: true,
    });
    const tests = detail({
      checks: [required("Tests", "success"), check("Smoke Tests", "pending")],
    });
    const first = evaluatePullRequestWatch(watch(), tests, noRemarks);
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: true }]);

    // The gate job was created and finished between two passes, so it was never seen pending.
    const gated = detail({
      checks: [
        required("Tests", "success"),
        check("Smoke Tests", "success"),
        required("Smoke Tests Gate", "success"),
      ],
    });
    const second = evaluatePullRequestWatch(first.next, gated, noRemarks);
    assert.deepEqual(second.changes, [{ kind: "checks-passed", count: 2, required: true }]);
    assert.deepEqual(evaluatePullRequestWatch(second.next, gated, noRemarks).changes, []);

    // Seen pending first, the gate is reported once it passes, as before.
    const pending = detail({
      checks: [required("Tests", "success"), required("Smoke Tests Gate", "pending")],
    });
    const waiting = evaluatePullRequestWatch(first.next, pending, noRemarks);
    assert.deepEqual(waiting.changes, []);
    assert.deepEqual(evaluatePullRequestWatch(waiting.next, gated, noRemarks).changes, [
      { kind: "checks-passed", count: 2, required: true },
    ]);
  });

  it("does not report passed again for a new passed check where none is required", () => {
    const first = evaluatePullRequestWatch(
      watch(),
      detail({ checks: [check("test", "success")] }),
      noRemarks,
    );
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: false }]);
    const both = detail({ checks: [check("test", "success"), check("lint", "success")] });
    assert.deepEqual(evaluatePullRequestWatch(first.next, both, noRemarks).changes, []);
  });

  it("does not wake a watch saved before passed checks were recorded", () => {
    const green = detail({ checks: [{ ...check("test", "success"), required: true }] });
    const told = watch({ headSha: "aaaaaaaaaa", passed: true });
    const saved = evaluatePullRequestWatch(told, green, noRemarks);
    assert.deepEqual(saved.changes, []);
    assert.deepEqual(saved.next.passedChecks, ["test"]);
  });

  it("keeps remarks for a later pass when the conversation was not read whole", () => {
    const comments = [remark("reviewer", "2026-10-02T12:06:00Z")];
    const partial = evaluatePullRequestWatch(watch(), detail(), null);
    assert.deepEqual(partial.changes, []);
    assert.equal(
      evaluatePullRequestWatch(partial.next, detail(), comments).changes[0]?.kind,
      "remarks",
    );
  });

  it("reports a remark that shows up late with the same time as a reported one", () => {
    const first = remark("reviewer", "2026-10-02T12:06:00Z");
    const late = { ...remark("bot", "2026-10-02T12:06:00Z"), id: "late" };
    const reported = evaluatePullRequestWatch(watch(), detail(), [first]);
    const again = evaluatePullRequestWatch(reported.next, detail(), [first, late]);
    assert.deepEqual(again.changes, [{ kind: "remarks", remarks: [late] }]);
    assert.deepEqual(again.next.remarkIds, [first.id, "late"]);
  });

  it("reports edits after the watermark once and counts them toward the wake limit", () => {
    const old = remark("greptile[bot]", "2026-10-02T11:00:00Z");
    const watching = watch({
      headSha: "aaaaaaaaaa",
      remarkIds: [old.id],
      wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1,
    });
    assert.deepEqual(evaluatePullRequestWatch(watching, detail(), [old]).changes, []);
    const edited = { ...old, editedAt: "2026-10-02T12:06:00Z" };
    const report = evaluatePullRequestWatch(watching, detail(), [edited]);
    assert.deepEqual(report.changes, [{ kind: "remarks", remarks: [edited] }]);
    assert.equal(report.next.remarksThrough, edited.editedAt);
    assert.deepEqual(report.next.remarkIds, [old.id]);
    assert.isTrue(report.exhausted);
    assert.deepEqual(evaluatePullRequestWatch(report.next, detail(), [edited]).changes, []);
    const late = { ...edited, id: "late" };
    assert.deepEqual(evaluatePullRequestWatch(report.next, detail(), [edited, late]).changes, [
      { kind: "remarks", remarks: [late] },
    ]);
  });

  it("does not treat a failed check read as a rerun", () => {
    const failed = detail({ checks: [check("lint", "failure")] });
    const reported = evaluatePullRequestWatch(watch(), failed, noRemarks);
    assert.equal(reported.changes.length, 1);
    const unreadable = evaluatePullRequestWatch(reported.next, detail({ checks: [] }), noRemarks);
    assert.deepEqual(evaluatePullRequestWatch(unreadable.next, failed, noRemarks).changes, []);
  });

  it("wakes for the pull request's author when the agent is someone else", () => {
    const contributor = detail({ author: { login: "contributor", name: null, avatarUrl: null } });
    const reply = remark("contributor", "2026-10-02T12:06:00Z");
    assert.deepEqual(evaluatePullRequestWatch(watch(), contributor, [reply]).changes, [
      { kind: "remarks", remarks: [reply] },
    ]);
    // Without a viewer, the author is taken to be the agent.
    const noViewer = detail({ viewer: undefined, author: contributor.author });
    assert.deepEqual(evaluatePullRequestWatch(watch(), noViewer, [reply]).changes, []);
  });

  it("reports remarks from others once and never the agent's own", () => {
    const comments = [
      remark("agent-user", "2026-10-02T12:05:00Z", "Fixed in the latest push."),
      remark("macroscope-app[bot]", "2026-10-02T12:06:00Z"),
      remark("reviewer", "2026-10-02T11:00:00Z", "Older than the watch."),
    ];
    const report = evaluatePullRequestWatch(watch(), detail(), comments);
    assert.deepEqual(report.changes, [{ kind: "remarks", remarks: [comments[1]!] }]);
    assert.equal(report.next.remarksThrough, "2026-10-02T12:06:00Z");
    assert.deepEqual(evaluatePullRequestWatch(report.next, detail(), comments).changes, []);
  });

  it("reports a conflict once, until the branch is clean again", () => {
    const conflicting = detail({ mergeability: "conflicting" });
    const first = evaluatePullRequestWatch(watch(), conflicting, noRemarks);
    assert.deepEqual(first.changes, [{ kind: "conflicting" }]);
    // GitHub answers "unknown" while it recomputes after a push; that is not a resolution.
    const recomputing = evaluatePullRequestWatch(
      first.next,
      detail({ mergeability: "unknown" }),
      noRemarks,
    );
    assert.deepEqual(
      evaluatePullRequestWatch(recomputing.next, conflicting, noRemarks).changes,
      [],
    );
    const clean = evaluatePullRequestWatch(first.next, detail(), noRemarks);
    assert.deepEqual(evaluatePullRequestWatch(clean.next, conflicting, noRemarks).changes, [
      { kind: "conflicting" },
    ]);
  });

  it("does not spend the comment wake limit on check results", () => {
    const tired = watch({ headSha: "aaaaaaaaaa", wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    const result = evaluatePullRequestWatch(
      tired,
      detail({ checks: [check("lint", "failure")] }),
      noRemarks,
    );
    assert.isFalse(result.exhausted);
    assert.equal(result.next.wakes, 0);
  });

  it("stops after the wake limit unless the head moves", () => {
    const comments = [remark("reviewer", "2026-10-02T12:10:00Z")];
    const tired = watch({ headSha: "aaaaaaaaaa", wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    assert.isTrue(evaluatePullRequestWatch(tired, detail(), comments).exhausted);
    const pushed = evaluatePullRequestWatch(tired, detail({ headSha: "cccccccccc" }), comments);
    assert.isFalse(pushed.exhausted);
    assert.equal(pushed.next.wakes, 1);
  });
});

describe("pullRequestWatchMessage", () => {
  it("tells the agent what changed and marks failures for the timeline", () => {
    const report = evaluatePullRequestWatch(
      watch(),
      detail({ checks: [check("lint", "failure")] }),
      [remark("reviewer", "2026-10-02T12:10:00Z", "<!-- bot -->Needs a test.")],
    );
    const message = pullRequestWatchMessage({
      number: 12,
      url: "https://github.com/o/r/pull/12",
      baseBranch: "main",
      headSha: report.next.headSha,
      report,
    });
    assert.include(message.text, "- Checks failed on aaaaaaa:\n  - lint https://ci.example/lint");
    assert.include(message.text, '  - reviewer on src/index.ts: "Needs a test."');
    assert.include(message.text, "unwatch_pull_request");
    assert.deepEqual(message.notification, {
      source: { kind: "monitor" },
      outcome: "failed",
      summary: "#12: checks failed, new comments",
    });
  });
});
