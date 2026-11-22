import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  judgeThread,
  lastLine,
  promisesToContinue,
  threadEventAlert,
  threadEventMessage,
  threadEventStillHolds,
  type ThreadEventTrigger,
  type WatchedShell,
} from "./ThreadEventAlerts.ts";

const NOW = Date.parse("2026-11-19T05:00:00.000Z");
const at = (minutesAgo: number) => DateTime.makeUnsafe(NOW - minutesAgo * 60_000);

// The Fleet rollout lane said this, settled with no tracked task, and its R720 build died unnoticed.
const FLEET_PROMISE =
  "The desktop build is running on R720. A background watch will wake this thread when it finishes, and I'll install it on ASUS after that. I'll settle this thread only once all three machines are confirmed.";

const shellWith = (overrides: Partial<WatchedShell> = {}): WatchedShell =>
  ({
    id: "thread:lane",
    title: "Fleet rollout",
    createdBy: "agent",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: null },
    status: "completed",
    activeRunId: null,
    latestRunId: "run:7",
    latestRunCompletedAt: at(2),
    activityRunStatus: null,
    blockedOnThreadWait: false,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    pullRequests: [],
    latestVisibleMessage: null,
    lastError: null,
    settledOverride: null,
    archivedAt: null,
    snoozedUntil: null,
    limitRecovery: null,
    updatedAt: at(2),
    ...overrides,
  }) as unknown as WatchedShell;

const judge = (
  shell: WatchedShell,
  trigger: ThreadEventTrigger,
  extra: Partial<Parameters<typeof judgeThread>[0]> = {},
) => judgeThread({ shell, trigger, nowMs: NOW, stuckMinutes: 20, ...extra });

const openPullRequest = {
  host: "github.com",
  repository: "nullStack65/t3code",
  number: 97,
  url: "https://github.com/nullStack65/t3code/pull/97",
  source: "agent",
  linkedAt: "2026-11-19T04:00:00.000Z",
  snapshot: null,
  stack: null,
} as never;

const assistantSays = (text: string) =>
  ({ id: "message:1", role: "assistant", text, updatedAt: at(2) }) as never;

it.each([
  ["a failed run", { status: "failed" }, ["lane-ended"]],
  ["an interrupted run", { status: "interrupted" }, ["lane-ended"]],
  ["a completed run with nothing open", { status: "completed" }, []],
  [
    "a completed run with an open pull request and no task",
    { status: "completed", pullRequests: [openPullRequest] },
    ["lane-ended"],
  ],
  [
    "a completed run with an open pull request and a tracked task",
    {
      status: "completed",
      pullRequests: [openPullRequest],
      pendingBackgroundTasks: [{ taskId: "pull-request-watch:97", kind: "monitor" }],
    },
    [],
  ],
  ["a failed run that ended long ago", { status: "failed", latestRunCompletedAt: at(120) }, []],
  ["a failed run on a settled lane", { status: "failed", settledOverride: "settled" }, []],
  [
    "a failed run on a delegated child",
    {
      status: "failed",
      lineage: { parentThreadId: "thread:lead", relationshipToParent: "subagent" },
    },
    [],
  ],
  ["a run still going", { status: "failed", activeRunId: "run:8" }, []],
] as const)("lane-ended: %s -> %j", (_name, overrides, expected) => {
  const { findings } = judge(shellWith(overrides as never), "run-ended");
  assert.deepEqual(
    findings.filter((finding) => finding.kind === "lane-ended").map((finding) => finding.kind),
    [...expected],
  );
});

it.each(["failed", "interrupted"] as const)(
  "a %s run on a thread a person created is not a lane event",
  (status) => {
    const { findings } = judge(shellWith({ status, createdBy: "user" } as never), "run-ended");
    assert.deepEqual(findings, []);
    const stuck = judge(
      shellWith({
        createdBy: "user",
        status: "running",
        activeRunId: "run:8",
        activityRunStatus: "running",
        updatedAt: at(90),
      } as never),
      "sweep",
    );
    assert.deepEqual(stuck.findings, []);
  },
);

it("lane-ended stays quiet for a failure the model alert already reported as a usage limit", () => {
  const { findings } = judge(shellWith({ status: "failed" } as never), "run-ended", {
    usageLimitReported: true,
  });
  assert.deepEqual(findings, []);
});

it("promise-without-wake: flags the Fleet lane's real message when nothing is tracked", () => {
  const { findings } = judge(
    shellWith({ latestVisibleMessage: assistantSays(FLEET_PROMISE) } as never),
    "run-ended",
  );
  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ["promise-without-wake"],
  );
  assert.equal(findings[0]?.signature, "message:1");
});

it.each([
  [
    "a tracked background command",
    { pendingBackgroundTasks: [{ taskId: "b1", kind: "command" }] },
    0,
  ],
  ["a delegated task on another machine", {}, 1],
  ["a pull request watch", { pullRequests: [{ ...(openPullRequest as object), watch: {} }] }, 0],
  ["an armed usage-limit resume", { limitRecovery: { autoResume: true } }, 0],
  ["a pending question", { pendingRuntimeRequest: { id: "request:1", kind: "user_input" } }, 0],
] as const)("promise-without-wake: %s is a wake handle", (_name, overrides, remoteTaskCount) => {
  const { findings } = judge(
    shellWith({ latestVisibleMessage: assistantSays(FLEET_PROMISE), ...overrides } as never),
    "run-ended",
    { remoteTaskCount },
  );
  assert.deepEqual(findings, []);
});

it("promise-without-wake: judges a settling thread even when its last run ended long ago", () => {
  // A settled lane is not `watched`, so the settle trigger sees the shell as it was just before.
  const { findings } = judge(
    shellWith({
      latestVisibleMessage: assistantSays(FLEET_PROMISE),
      latestRunCompletedAt: at(300),
    } as never),
    "settled",
  );
  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ["promise-without-wake"],
  );
});

it.each([
  [FLEET_PROMISE, true],
  ["I'll install the desktop build after the R720 build finishes.", true],
  ["Keeping this lane open until the rollout is verified.", true],
  ["I'll be woken when the command ends.", true],
  ["The rollout is live on all three machines. Nothing left to do.", false],
  ["I installed it after the build finished.", false],
] as const)("promise phrases: %j -> %s", (text, expected) => {
  assert.equal(promisesToContinue(text), expected);
});

it("stuck: an active run with no new item for the configured minutes", () => {
  const active = { activeRunId: "run:8", status: "running", activityRunStatus: "running" };
  const quiet = judge(shellWith({ ...active, updatedAt: at(25) } as never), "sweep");
  assert.deepEqual(
    quiet.findings.map((finding) => [finding.kind, finding.signature]),
    [["stuck", "run:8"]],
  );
  assert.deepEqual(
    judge(shellWith({ ...active, updatedAt: at(5) } as never), "sweep").findings,
    [],
  );
  // The threshold is configurable and zero turns the check off.
  assert.deepEqual(
    judge(shellWith({ ...active, updatedAt: at(5) } as never), "sweep", { stuckMinutes: 3 })
      .findings.length,
    1,
  );
  assert.deepEqual(
    judge(shellWith({ ...active, updatedAt: at(500) } as never), "sweep", { stuckMinutes: 0 })
      .findings,
    [],
  );
  // A parent whose child is still working is not stuck.
  assert.deepEqual(
    judge(shellWith({ ...active, updatedAt: at(25) } as never), "sweep", {
      childActivityMs: NOW - 60_000,
    }).findings,
    [],
  );
});

it("stuck: a thread waiting on background work that no longer exists", () => {
  const waiting = { status: "waiting", activityRunStatus: "waiting", updatedAt: at(30) };
  const orphan = judge(shellWith(waiting as never), "sweep");
  assert.deepEqual(
    orphan.findings.map((finding) => [finding.kind, finding.signature]),
    [["stuck", "run:7:orphan-wait"]],
  );
  const tracked = judge(
    shellWith({
      ...waiting,
      pendingBackgroundTasks: [{ taskId: "bdejsjjol", kind: "command", awaited: true }],
    } as never),
    "sweep",
  );
  assert.deepEqual(tracked.findings, []);
});

it("stuck: a stranded queue reports strictly after 15 minutes with a stable incident signature", () => {
  const shell = shellWith({ latestRunCompletedAt: at(15) });
  const strandedQueue = { runId: "queued:1", requestedAt: at(30) };
  const sweep = (nowMs: number, runId = strandedQueue.runId, thread = shell) =>
    judge(thread, "sweep", { nowMs, strandedQueue: { ...strandedQueue, runId } } as never);
  assert.deepEqual(sweep(NOW - 1).findings, []);
  assert.deepEqual(sweep(NOW).findings, []);
  const [first] = sweep(NOW + 1).findings;
  assert.isDefined(first);
  assert.equal(first.kind, "stuck");
  assert.equal(sweep(NOW + 60_000).findings[0]?.signature, first.signature);
  assert.notEqual(sweep(NOW + 60_000, "queued:2").findings[0]?.signature, first.signature);
  assert.deepEqual(
    judge(shell, "sweep", {
      nowMs: NOW + 1,
      strandedQueue: { ...strandedQueue, queueHeld: true },
    } as never).findings,
    [],
  );
  for (const gate of [
    { snoozedUntil: at(-2) },
    { latestRunStopRequested: true },
    { pendingRuntimeRequest: { id: "request:1", kind: "approval" } },
  ]) {
    assert.deepEqual(
      sweep(
        NOW + 1,
        strandedQueue.runId,
        shellWith({
          latestRunCompletedAt: at(15),
          ...gate,
        } as never),
      ).findings,
      [],
    );
  }
});

it("needs-person: an agent lane raising a question or flipping to a founder", () => {
  const question = judge(
    shellWith({
      pendingRuntimeRequest: { id: "request:9", kind: "approval", userOnly: false },
    } as never),
    "request",
  );
  assert.deepEqual(
    question.findings.map((finding) => [finding.kind, finding.signature]),
    [["needs-person", "request:request:9"]],
  );
  const flipped = judge(
    shellWith({
      inbox: {
        owner: "kameron",
        assignee: { kind: "human", id: "kameron" },
        audience: "kameron",
        attentionKind: "action",
        reason: "decision",
        decisionRequest: {
          founder: "kameron",
          kind: "decision",
          question: "Spend $20 on the build host?",
          requestedAt: "2026-11-19T04:59:00.000Z",
        },
      },
    } as never),
    "inbox",
  );
  assert.equal(flipped.findings.length, 1);
  assert.match(flipped.findings[0]!.detail, /assigned to kameron.*Spend \$20/);
  // An agent-only background lane, and a thread a founder opened themselves, do not alert.
  assert.deepEqual(
    judge(
      shellWith({
        inbox: {
          owner: null,
          assignee: null,
          audience: "agent-only",
          attentionKind: "background",
        },
      } as never),
      "inbox",
    ).findings,
    [],
  );
  assert.deepEqual(
    judge(
      shellWith({
        createdBy: "user",
        pendingRuntimeRequest: { id: "request:9", kind: "approval" },
      } as never),
      "request",
    ).findings,
    [],
  );
});

it("a recurrence of the same state is a new message", () => {
  const shell = shellWith({ status: "failed" } as never);
  const finding = judge(shell, "run-ended").findings[0]!;
  const make = (occurredAt: string) =>
    threadEventAlert({
      environmentId: "env-r720" as never,
      environmentLabel: "primary-r720",
      shell,
      finding,
      occurredAt,
      recipient: null,
    });
  assert.notEqual(make("2026-11-19T05:00:00.000Z").id, make("2026-11-19T05:30:00.000Z").id);
});

const fired = (overrides: Partial<WatchedShell>, trigger: ThreadEventTrigger) => {
  const shell = shellWith(overrides);
  const finding = judge(shell, trigger).findings[0]!;
  return threadEventAlert({
    environmentId: "env-r720" as never,
    environmentLabel: "primary-r720",
    shell,
    finding,
    occurredAt: DateTime.formatIso(DateTime.makeUnsafe(NOW)),
    recipient: null,
  });
};
const stillHolds = (
  alert: ReturnType<typeof fired>,
  overrides: Partial<WatchedShell>,
  base: Partial<WatchedShell>,
) =>
  threadEventStillHolds({ alert, shell: shellWith({ ...base, ...overrides }), stuckMinutes: 20 });

const failed = { status: "failed" } as never;
const openWithPr = { status: "completed", pullRequests: [openPullRequest] } as never;
const quietRun = {
  activeRunId: "run:8",
  status: "running",
  activityRunStatus: "running",
  updatedAt: at(25),
} as never;
const asking = {
  pendingRuntimeRequest: { id: "request:9", kind: "approval", userOnly: false },
} as never;
const promised = { status: "idle", latestVisibleMessage: assistantSays(FLEET_PROMISE) } as never;

it.each([
  ["lane-ended, nothing changed", failed, "run-ended", {}, true],
  ["lane-ended, the lane restarted itself", failed, "run-ended", quietRun, false],
  [
    "lane-ended, a newer run already finished",
    failed,
    "run-ended",
    { latestRunId: "run:8", status: "completed" },
    false,
  ],
  ["lane-ended, the lane was settled", failed, "run-ended", { settledOverride: "settled" }, false],
  ["lane-ended, the lane was archived", failed, "run-ended", { archivedAt: at(1) }, false],
  [
    "lane-ended with an open PR, a PR watch registered since",
    openWithPr,
    "run-ended",
    { pendingBackgroundTasks: [{ taskId: "pull-request-watch:97", kind: "monitor" }] },
    false,
  ],
  [
    "lane-ended with an open PR, the PR merged since",
    openWithPr,
    "run-ended",
    { pullRequests: [{ ...(openPullRequest as object), snapshot: { state: "merged" } }] },
    false,
  ],
  ["lane-ended with an open PR, nothing changed", openWithPr, "run-ended", {}, true],
  ["stuck, nothing changed", quietRun, "sweep", {}, true],
  ["stuck, new activity since", quietRun, "sweep", { updatedAt: at(-1) }, false],
  [
    "needs-person, the question was answered",
    asking,
    "request",
    { pendingRuntimeRequest: null },
    false,
  ],
  ["needs-person, still unanswered", asking, "request", {}, true],
  ["promise-without-wake, nothing changed", promised, "settled", {}, true],
  [
    "promise-without-wake, a real wait registered since",
    promised,
    "settled",
    { pendingBackgroundTasks: [{ taskId: "b1", kind: "command" }] },
    false,
  ],
] as const)("at delivery, %s -> still holds %s", (_name, base, trigger, now, expected) => {
  const alert = fired(base, trigger);
  assert.equal(stillHolds(alert, now as never, base), expected);
});

it("a thread event still holds when delivery waited past the recent-run window", () => {
  // Judged at the time it fired, not now: a watcher offline for two hours still hears it.
  const alert = fired(failed, "run-ended");
  assert.equal(stillHolds(alert, {}, failed), true);
  assert.equal(stillHolds({ ...alert, occurredAt: "not a time" }, quietRun, failed), true);
});

it("each trigger evaluates only the kinds it can change", () => {
  assert.deepEqual(judge(shellWith(), "run-ended").evaluated, [
    "lane-ended",
    "promise-without-wake",
  ]);
  assert.deepEqual(judge(shellWith(), "sweep").evaluated, ["stuck"]);
  assert.deepEqual(judge(shellWith(), "inbox").evaluated, ["needs-person"]);
});

it("the wake carries environment, thread link, title, kind, run, last line and open pull requests", () => {
  const shell = shellWith({
    status: "completed",
    pullRequests: [openPullRequest],
    latestVisibleMessage: assistantSays(`${"x".repeat(400)}\n${FLEET_PROMISE}`),
  } as never);
  const finding = judge(shell, "run-ended").findings[0]!;
  const alert = threadEventAlert({
    environmentId: "env-r720" as never,
    environmentLabel: "primary-r720",
    shell,
    finding,
    occurredAt: "2026-11-19T05:00:00.000Z",
    recipient: null,
  });
  assert.equal(alert.runId, "run:7");
  assert.equal(alert.threadTitle, "Fleet rollout");
  assert.deepEqual(alert.openPullRequests, ["https://github.com/nullStack65/t3code/pull/97"]);
  const message = threadEventMessage(alert);
  assert.include(message, "primary-r720");
  assert.include(message, "env-r720");
  assert.include(message, "Fleet rollout");
  assert.include(message, "Event: lane-ended.");
  assert.include(message, "Run run:7.");
  assert.include(message, "pull/97");
  assert.include(message, "Last assistant line:");
  assert.isAtMost(lastLine("a".repeat(1000))!.length, 240);
});
