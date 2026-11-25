import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { EnvironmentId, type OrchestrationV2Run, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  afterDeliveryAttempt,
  afterDrop,
  afterHold,
  BUSY_WATCHER_MAX_HOLD_MS,
  BUSY_WATCHER_RECHECK_MS,
  busyWatcherHold,
  deliverAlertToWatcher,
  INCIDENT_GROUP_INTERVAL_MS,
  INCIDENT_GROUP_WAIT_MS,
  EMPTY_MODEL_ALERT_STATE,
  type ModelAlert,
  modelAlertDestinations,
  modelAlertFor,
  overdueResumes,
  type PeerLinkRenewalAlert,
  recordLinkRenewal,
  recordModelAlert,
  recordUsageLimit,
  RESUME_GRACE_MS,
  recordThreadEvents,
  threadEventDestinations,
  watcherAlertMessage,
} from "./ModelAlertReactor.ts";
import { ProviderExhaustion } from "./ProviderExhaustion.ts";
import { REDIRECT_LEDGER_ENV } from "./RetiredThreadRedirect.ts";
import { alertIsStale, expectsAutoResume, replacedBySibling } from "./UsageLimitIncidents.ts";
import type { ThreadEventAlert, ThreadEventKind, ThreadFinding } from "./ThreadEventAlerts.ts";

const alertFor = (runId: string, overrides: Partial<ModelAlert> = {}): ModelAlert => ({
  type: "model-degraded",
  id: `env:${runId}`,
  environmentId: "env",
  environmentLabel: "primary-r720",
  threadId: "thread:fleet",
  threadTitle: "Fleet overnight",
  threadLink: "[Fleet overnight](t3-thread://v2/env/thread:fleet)",
  parentThreadId: null,
  runId,
  runStatus: "completed",
  providerInstanceId: "claudeAgent",
  selectedModel: "claude-opus-5-5",
  executedModel: "claude-opus-4-8",
  fallbackModels: ["claude-opus-4-8"],
  reasons: ["model_substituted", "provider_fallback"],
  occurredAt: "2026-11-19T03:00:00.000Z",
  ...overrides,
});

const record = (
  state: typeof EMPTY_MODEL_ALERT_STATE,
  alert: ModelAlert | undefined,
  healthy = false,
) =>
  recordModelAlert(state, { alert, healthy, threadId: "thread:fleet" }, ["watcher", "webhook"], 0);

it("alerts a thread that falls back every run once, until it recovers or changes", () => {
  let state = EMPTY_MODEL_ALERT_STATE;
  const enqueued: Array<boolean> = [];
  const step = (alert: ModelAlert | undefined, healthy = false) => {
    const result = record(state, alert, healthy);
    state = result.state;
    enqueued.push(result.enqueued);
  };
  step(alertFor("run:1"));
  step(alertFor("run:2"));
  step(alertFor("run:3"));
  // A run with no model report says nothing either way.
  step(undefined);
  step(alertFor("run:4"));
  // A different problem alerts again.
  step(alertFor("run:5", { reasons: ["usage_limit"], executedModel: null, fallbackModels: [] }));
  step(undefined, true);
  step(alertFor("run:6"));
  assert.deepEqual(enqueued, [true, false, false, false, false, true, false, true]);
  assert.deepEqual(
    state.outbox.map((entry) => [
      entry.alert.type === "model-degraded" ? entry.alert.runId : entry.alert.id,
      entry.destination,
    ]),
    [
      ["run:1", "watcher"],
      ["run:1", "webhook"],
      ["run:5", "watcher"],
      ["run:5", "webhook"],
      ["run:6", "watcher"],
      ["run:6", "webhook"],
    ],
  );
});

it("keeps a failed delivery with a growing delay and drops a delivered one", () => {
  const { state } = recordModelAlert(
    EMPTY_MODEL_ALERT_STATE,
    { alert: alertFor("run:1"), healthy: false, threadId: "thread:fleet" },
    ["watcher", "webhook"],
    0,
  );
  const [watcher, webhook] = state.outbox;
  const once = afterDeliveryAttempt(state, watcher!, false, 1_000);
  const twice = afterDeliveryAttempt(once, once.outbox[0]!, false, 20_000);
  assert.deepEqual(
    twice.outbox.map((entry) => [entry.destination, entry.attempts, entry.nextAttemptAt]),
    [
      ["watcher", 2, 50_000],
      ["webhook", 0, 0],
    ],
  );
  const delivered = afterDeliveryAttempt(twice, webhook!, true, 21_000);
  assert.deepEqual(
    delivered.outbox.map((entry) => entry.destination),
    ["watcher"],
  );
  // A week later an undeliverable alert is dropped.
  assert.deepEqual(
    afterDeliveryAttempt(delivered, webhook!, true, 8 * 24 * 60 * 60 * 1000).outbox,
    [],
  );
});

it.each([
  ["completed", true],
  ["failed", false],
  ["interrupted", false],
] as const)("a %s run with no model report is healthy: %s", (status, healthy) => {
  const outcome = modelAlertFor({
    environmentId: EnvironmentId.make("env"),
    environmentLabel: "box",
    thread: {
      id: ThreadId.make("thread:codex"),
      title: "Codex",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: null },
    } as never,
    run: {
      id: "run:codex",
      status,
      activeAttemptId: null,
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    } as unknown as OrchestrationV2Run,
    projection: { turnItems: [], providerTurns: [] },
    occurredAt: "2026-11-19T03:00:00.000Z",
  });
  assert.deepEqual(outcome, { alert: undefined, healthy });
});

it.each([
  ["a top-level thread", null, null, "", ["watcher"]],
  ["a delegated child of the watcher", "subagent", "thread:lead", "", []],
  ["a fork of the watcher", "fork", "thread:lead", "", ["watcher"]],
  [
    "a child of another thread",
    "subagent",
    "thread:other",
    "https://hooks.example/x",
    ["watcher", "webhook"],
  ],
] as const)("%s alerts %j", (_name, relationshipToParent, parentThreadId, webhookUrl, expected) => {
  const here = EnvironmentId.make("env");
  assert.deepEqual(
    modelAlertDestinations({
      watcher: { environmentId: here, threadId: ThreadId.make("thread:lead") },
      webhookUrl,
      here,
      lineage: {
        relationshipToParent,
        parentThreadId: parentThreadId === null ? null : ThreadId.make(parentThreadId),
      },
    }),
    expected,
  );
});

// Like threadEventAlert, each occurrence gets its own id.
let occurrence = 0;
const eventAlert = (finding: ThreadFinding): ThreadEventAlert => ({
  type: "thread-event",
  kind: finding.kind,
  id: `env:thread:fleet:${finding.kind}:${finding.signature}:${DateTime.formatIso(DateTime.makeUnsafe(occurrence))}`,
  environmentId: "env",
  environmentLabel: "primary-r720",
  threadId: "thread:fleet",
  threadTitle: "Fleet overnight",
  threadLink: "[Fleet overnight](t3-thread://v2/env/thread:fleet)",
  runId: "run:1",
  detail: finding.detail,
  lastAssistantLine: "A background watch will wake this thread.",
  lastError: null,
  openPullRequests: [],
  occurredAt: DateTime.formatIso(DateTime.makeUnsafe(occurrence++)),
});

const finding = (kind: ThreadEventKind, signature: string): ThreadFinding => ({
  kind,
  signature,
  detail: `${kind} detail`,
});

it("reports a thread event once per kind and signature until its state changes", () => {
  let state = EMPTY_MODEL_ALERT_STATE;
  const enqueued: Array<boolean> = [];
  const step = (
    evaluated: ReadonlyArray<ThreadEventKind>,
    findings: ReadonlyArray<ThreadFinding>,
  ) => {
    const result = recordThreadEvents(
      state,
      { threadId: "thread:fleet", evaluated, findings },
      eventAlert,
      ["watcher"],
      0,
    );
    state = result.state;
    enqueued.push(result.enqueued);
  };
  step(["stuck"], [finding("stuck", "run:1")]);
  // The same run still stuck on the next sweep says nothing.
  step(["stuck"], [finding("stuck", "run:1")]);
  // Another kind on the same thread is its own event.
  step(["lane-ended"], [finding("lane-ended", "run:1")]);
  // A trigger that does not evaluate a kind leaves its dedupe alone.
  step(["needs-person"], []);
  step(["stuck"], [finding("stuck", "run:1")]);
  // Recovery clears it, so the same state reports again as a new occurrence.
  step(["stuck"], []);
  step(["stuck"], [finding("stuck", "run:1")]);
  step(["stuck"], [finding("stuck", "run:2")]);
  assert.deepEqual(enqueued, [true, false, true, false, false, false, true, true]);
  assert.deepEqual(
    state.outbox.map((entry) => (entry.alert.type === "thread-event" ? entry.alert.kind : "")),
    ["stuck", "lane-ended", "stuck", "stuck"],
  );
});

it("deduplicates a stranded queue until the queue advances or drains", () => {
  let state = EMPTY_MODEL_ALERT_STATE;
  const step = (runId: string | null, actionable: boolean, nowMs: number) => {
    const result = recordThreadEvents(
      state,
      {
        threadId: "thread:fleet",
        evaluated: ["stuck"],
        findings: runId !== null && actionable ? [finding("stuck", `stranded-queue:${runId}`)] : [],
        strandedQueue: runId === null ? null : { runId, requestedAt: DateTime.makeUnsafe(0) },
      },
      eventAlert,
      ["watcher"],
      nowMs,
    );
    state = result.state;
    return result.enqueued;
  };
  assert.isTrue(step("queued:1", true, 1));
  assert.isFalse(step("queued:1", false, 2));
  assert.isFalse(step("queued:1", true, 3));
  const [undelivered] = state.outbox;
  assert.isDefined(undelivered);
  state = afterDrop(state, undelivered, 4);
  assert.isTrue(step("queued:1", true, 5));
  const [delivered] = state.outbox;
  assert.isDefined(delivered);
  state = afterDeliveryAttempt(state, delivered, true, 6);
  assert.isFalse(step("queued:1", false, 7));
  assert.isFalse(step("queued:1", true, 8));
  assert.isTrue(step("queued:2", true, 9));
  assert.isFalse(step(null, false, 10));
  assert.isTrue(step("queued:3", true, 11));
});

it("a thread holding a question and an inbox flip reports each once, not on every trigger", () => {
  const both = [finding("needs-person", "request:1"), finding("needs-person", "inbox:kameron")];
  let state = EMPTY_MODEL_ALERT_STATE;
  const enqueued: Array<boolean> = [];
  const step = (findings: ReadonlyArray<ThreadFinding>) => {
    const result = recordThreadEvents(
      state,
      { threadId: "thread:fleet", evaluated: ["needs-person"], findings },
      eventAlert,
      ["watcher"],
      0,
    );
    state = result.state;
    enqueued.push(result.enqueued);
  };
  step(both);
  step(both);
  step(both);
  // The question is answered; the inbox flip is still open and was already reported.
  step([both[1]!]);
  // Then the flip clears and returns: a new occurrence.
  step([]);
  step([both[1]!]);
  assert.deepEqual(enqueued, [true, false, false, false, false, true]);
  assert.equal(state.outbox.length, 3);
});

it("queues one delivery per destination for a thread event, beside model alerts", () => {
  const { state, enqueued } = recordThreadEvents(
    EMPTY_MODEL_ALERT_STATE,
    {
      threadId: "thread:fleet",
      evaluated: ["needs-person"],
      findings: [finding("needs-person", "request:1")],
    },
    eventAlert,
    ["watcher", "webhook"],
    0,
  );
  assert.equal(enqueued, true);
  assert.deepEqual(
    state.outbox.map((entry) => [entry.alert.type, entry.destination]),
    [
      ["thread-event", "watcher"],
      ["thread-event", "webhook"],
    ],
  );
  const withModel = recordModelAlert(
    state,
    { alert: alertFor("run:1"), healthy: false, threadId: "thread:fleet" },
    ["watcher"],
    0,
  );
  assert.deepEqual(
    withModel.state.outbox.map((entry) => entry.alert.type),
    ["thread-event", "thread-event", "model-degraded"],
  );
  assert.include(watcherAlertMessage(alertFor("run:1")), "Model alert from");
  assert.include(watcherAlertMessage(eventAlert(finding("stuck", "run:1"))), "Thread event from");
});

it("a thread event with nowhere to go stays unreported until a destination exists", () => {
  const judged = {
    threadId: "thread:fleet",
    evaluated: ["lane-ended"] as const,
    findings: [finding("lane-ended", "run:1")],
  };
  const dropped = recordThreadEvents(EMPTY_MODEL_ALERT_STATE, judged, eventAlert, [], 0);
  assert.equal(dropped.enqueued, false);
  assert.deepEqual(dropped.state.outbox, []);
  assert.deepEqual(dropped.state.reported, {});
  // The same event again, still with nowhere to go, changes nothing.
  const again = recordThreadEvents(dropped.state, judged, eventAlert, [], 0);
  assert.equal(again.enqueued, false);
  assert.deepEqual(again.state.outbox, []);
  assert.deepEqual(again.state.reported, {});
  // A webhook configured later receives the event that was dropped.
  const delivered = recordThreadEvents(dropped.state, judged, eventAlert, ["webhook"], 0);
  assert.equal(delivered.enqueued, true);
  assert.deepEqual(
    delivered.state.outbox.map((entry) => entry.destination),
    ["webhook"],
  );
  // And once delivered it stays quiet.
  const quiet = recordThreadEvents(delivered.state, judged, eventAlert, ["webhook"], 0);
  assert.equal(quiet.enqueued, false);
});

it("a thread event with no launching thread to hear it goes only to a configured webhook", () => {
  const cto = { environmentId: EnvironmentId.make("laptop"), threadId: ThreadId.make("cto") };
  assert.deepEqual(threadEventDestinations(cto, ""), ["watcher"]);
  assert.deepEqual(threadEventDestinations(cto, "https://hooks.example/alerts"), [
    "watcher",
    "webhook",
  ]);
  assert.deepEqual(threadEventDestinations(null, "https://hooks.example/alerts"), ["webhook"]);
  assert.deepEqual(threadEventDestinations(null, "  "), []);
});

it.effect("forwards a thread event to a watcher on another environment with one retry key", () =>
  Effect.gen(function* () {
    const dispatched: Array<unknown> = [];
    const called: Array<{
      readonly arguments?: Record<string, unknown>;
      readonly environmentId: string;
    }> = [];
    const deps = {
      dispatch: (command: unknown) => Effect.sync(() => void dispatched.push(command)),
      call: (input: never) => Effect.sync(() => void called.push(input)),
      sha256Hex: (identity: string) => Effect.succeed(`digest(${identity.length})`),
    } as never;
    const alert = eventAlert(finding("promise-without-wake", "message:1"));
    const laptop = { environmentId: EnvironmentId.make("laptop"), threadId: ThreadId.make("lead") };
    yield* deliverAlertToWatcher(deps, alert, laptop, EnvironmentId.make("r720"));
    yield* deliverAlertToWatcher(deps, alert, laptop, EnvironmentId.make("r720"));
    assert.equal(dispatched.length, 0);
    assert.equal(called.length, 2);
    assert.equal(called[0]!.environmentId, "laptop");
    assert.equal(called[0]!.arguments?.threadId, "lead");
    assert.equal(called[0]!.arguments?.mode, "queue");
    assert.equal(called[0]!.arguments?.message, watcherAlertMessage(alert));
    assert.match(String(called[0]!.arguments?.clientRequestId), /^thread-event:/);
    assert.equal(called[0]!.arguments?.clientRequestId, called[1]!.arguments?.clientRequestId);

    // The same alert on the watcher's own machine queues into the thread directly.
    yield* deliverAlertToWatcher(deps, alert, laptop, EnvironmentId.make("laptop"));
    assert.equal(called.length, 2);
    assert.equal(dispatched.length, 1);
    assert.equal((dispatched[0] as { threadId: string }).threadId, "lead");
    assert.deepEqual((dispatched[0] as { dispatchMode: unknown }).dispatchMode, {
      type: "queue_after_active",
    });
  }),
);

it.effect("sends an alert for a retired watcher to its replacement and records the redirect", () =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-redirect-alert-"));
    const ledger = NodePath.join(dir, "redirects.jsonl");
    const previous = process.env[REDIRECT_LEDGER_ENV];
    process.env[REDIRECT_LEDGER_ENV] = ledger;
    try {
      const dispatched: Array<{ threadId: string }> = [];
      const tombstones: Record<string, string | null> = { old: "new", new: null, loop: "loop" };
      const deps = {
        dispatch: (command: { threadId: string }) =>
          Effect.sync(() => void dispatched.push(command)),
        call: () => Effect.die("local watcher"),
        sha256Hex: (identity: string) => Effect.succeed(`digest(${identity.length})`),
        getThreadShell: (threadId: string) =>
          Effect.succeed(
            threadId in tombstones
              ? {
                  replacedByThreadId: tombstones[threadId]
                    ? ThreadId.make(tombstones[threadId])
                    : null,
                }
              : null,
          ),
      } as never;
      const alert = eventAlert(finding("promise-without-wake", "message:1"));
      const here = EnvironmentId.make("laptop");
      const watcher = (id: string) => ({ environmentId: here, threadId: ThreadId.make(id) });

      yield* deliverAlertToWatcher(deps, alert, watcher("old"), here);
      assert.deepEqual(
        dispatched.map((command) => command.threadId),
        ["new"],
      );
      const records = NodeFS.readFileSync(ledger, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.sourceKind, "event");
      assert.equal(records[0]!.retiredThreadId, "old");
      assert.equal(records[0]!.redirectedToThreadId, "new");

      // A watcher that cannot be resolved drops the alert: nothing is dispatched anywhere.
      yield* deliverAlertToWatcher(deps, alert, watcher("loop"), here);
      assert.equal(dispatched.length, 1);
    } finally {
      if (previous === undefined) delete process.env[REDIRECT_LEDGER_ENV];
      else process.env[REDIRECT_LEDGER_ENV] = previous;
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }),
);

const limitInput = (
  index: number,
  overrides: Partial<Parameters<typeof recordUsageLimit>[1]> = {},
) => ({
  member: {
    threadId: `thread:${index}`,
    threadTitle: `Lane ${index}`,
    threadLink: `[Lane ${index}](t3-thread://v2/env/thread:${index})`,
    runId: `run:${index}`,
  },
  environmentId: "env",
  environmentLabel: "primary-r720",
  providerInstanceId: "claudeAgent",
  resetAt: "2026-11-19T09:00:00.000Z",
  resumeFailed: false,
  willResume: false,
  signature: `usage_limit:limit:run:${index}`,
  occurredAt: "2026-11-19T04:00:00.000Z",
  ...overrides,
});

const stormOf = (
  count: number,
  overrides: Partial<Parameters<typeof recordUsageLimit>[1]> = {},
  destinations: ReadonlyArray<"watcher" | "webhook"> = ["watcher"],
) => {
  let state = EMPTY_MODEL_ALERT_STATE;
  for (let index = 0; index < count; index += 1) {
    state = recordUsageLimit(
      state,
      limitInput(index, overrides),
      destinations,
      1_000 + index,
    ).state;
  }
  return state;
};

it("20 threads hitting one usage limit queue exactly one Lead-facing item", () => {
  const state = stormOf(20);
  assert.equal(state.outbox.length, 1);
  const [entry] = state.outbox;
  assert.equal(entry!.destination, "watcher");
  assert.equal(entry!.alert.type, "usage-limit-incident");
  if (entry!.alert.type !== "usage-limit-incident") return;
  assert.equal(entry!.alert.members.length, 20);
  assert.equal(entry!.alert.resetAt, "2026-11-19T09:00:00.000Z");
  // The first member waits for the rest of the storm.
  assert.equal(entry!.nextAttemptAt, 1_000 + INCIDENT_GROUP_WAIT_MS);
  const message = watcherAlertMessage(entry!.alert);
  assert.include(message, "20 threads stopped");
  assert.include(message, "resets at 2026-11-19T09:00:00.000Z");
  assert.include(message, "[Lane 19]");
  assert.notInclude(message, "Model alert from");
});

it("a repeat on the same run, or another run of an already listed thread, adds no item", () => {
  let state = stormOf(3);
  state = recordUsageLimit(state, limitInput(1), ["watcher"], 5_000).state;
  state = recordUsageLimit(
    state,
    limitInput(1, {
      signature: "usage_limit:limit:run:99",
      member: { ...limitInput(1).member, runId: "run:99" },
    }),
    ["watcher"],
    6_000,
  ).state;
  assert.equal(state.outbox.length, 1);
  const alert = state.outbox[0]!.alert;
  assert.equal(alert.type === "usage-limit-incident" && alert.members.length, 3);
});

it("a limit with auto-resume ahead sends Lead nothing, and a thread that comes back clears", () => {
  let state = stormOf(20, { willResume: true });
  assert.equal(state.outbox.length, 0);
  assert.equal(Object.keys(state.resuming).length, 20);
  state = recordModelAlert(
    state,
    { alert: undefined, healthy: true, threadId: "thread:3" },
    ["watcher"],
    2_000,
  ).state;
  assert.equal(Object.keys(state.resuming).length, 19);
  assert.equal(state.resuming["thread:3"], undefined);
});

it("threads that do not come back after the reset make one separate incident", () => {
  let state = stormOf(20, { willResume: true });
  const nowMs = Date.parse("2026-11-19T09:00:00.000Z") + RESUME_GRACE_MS + 1;
  assert.deepEqual(overdueResumes(state, nowMs - 2).length, 0);
  const overdue = overdueResumes(state, nowMs);
  assert.equal(overdue.length, 20);
  for (const [threadId, entry] of overdue) {
    const index = Number(threadId.split(":")[1]);
    const { [threadId]: _done, ...resuming } = state.resuming;
    state = recordUsageLimit(
      { ...state, resuming },
      limitInput(index, {
        resumeFailed: true,
        signature: `usage_limit:resume-missed:${entry.runId}`,
      }),
      ["watcher"],
      nowMs,
    ).state;
  }
  assert.equal(state.outbox.length, 1);
  const alert = state.outbox[0]!.alert;
  assert.equal(alert.type === "usage-limit-incident" && alert.resumeFailed, true);
  assert.include(watcherAlertMessage(alert), "did not come back after the limit reset");
});

it("members joining while a digest is sent wait for the next one, and stragglers wait a group interval", () => {
  const state = stormOf(2);
  const sent = state.outbox[0]!;
  const joined = recordUsageLimit(state, limitInput(2), ["watcher"], 40_000).state;
  assert.equal(joined.outbox.length, 1);
  const afterSend = afterDeliveryAttempt(joined, sent, true, 41_000);
  assert.equal(afterSend.outbox.length, 1);
  const rest = afterSend.outbox[0]!;
  assert.equal(rest.alert.type === "usage-limit-incident" && rest.alert.members.length, 1);
  assert.equal(rest.nextAttemptAt, 41_000 + INCIDENT_GROUP_INTERVAL_MS);
  // Once nothing joined, the sent digest is gone and a later thread starts a delayed new item.
  const quiet = afterDeliveryAttempt(state, sent, true, 41_000);
  assert.equal(quiet.outbox.length, 0);
  const later = recordUsageLimit(quiet, limitInput(7), ["watcher"], 50_000).state;
  assert.equal(later.outbox.length, 1);
  assert.equal(later.outbox[0]!.nextAttemptAt, 41_000 + INCIDENT_GROUP_INTERVAL_MS);
  assert.notEqual(later.outbox[0]!.alert.id, sent.alert.id);
  // The leftover digest has its own id, so its delivery key is not a replay of the first.
  assert.notEqual(rest.alert.id, sent.alert.id);
});

it("a held item waits without failing, and a dropped one leaves without counting as sent", () => {
  const state = stormOf(2);
  const entry = state.outbox[0]!;
  const held = afterHold(state, entry, 999_000);
  assert.deepEqual([held.outbox[0]!.attempts, held.outbox[0]!.nextAttemptAt], [0, 999_000]);
  // Members still merge into a held item, so Lead gets one digest when it is back.
  const merged = recordUsageLimit(held, limitInput(5), ["watcher"], 70_000).state;
  assert.equal(merged.outbox.length, 1);
  assert.equal(merged.outbox[0]!.nextAttemptAt, 999_000);
  // The snapshot was judged stale, but a thread joined after it: that one still reaches Lead.
  const dropped = afterDrop(merged, entry, 80_000);
  assert.equal(dropped.outbox.length, 1);
  const rest = dropped.outbox[0]!.alert;
  assert.deepEqual(
    rest.type === "usage-limit-incident" && rest.members.map((member) => member.threadId),
    ["thread:5"],
  );
  assert.notEqual(rest.id, entry.alert.id);
  assert.equal(afterDrop(held, entry, 80_000).outbox.length, 0);
  assert.deepEqual(dropped.incidentSentAt, {});
});

it.each([
  ["an idle watcher", "idle", 0, null],
  ["a watcher that cannot be read", null, 0, null],
  ["a watcher mid-turn", "running", 0, BUSY_WATCHER_RECHECK_MS],
  ["a watcher with a queued turn", "queued", 0, BUSY_WATCHER_RECHECK_MS],
  ["a watcher waiting on its own background work", "waiting", 0, BUSY_WATCHER_RECHECK_MS],
  ["a watcher busy near the cap", "running", BUSY_WATCHER_MAX_HOLD_MS - 1_000, 1_000],
  ["a watcher busy past the cap", "running", BUSY_WATCHER_MAX_HOLD_MS, null],
] as const)("busy watcher hold: %s", (_name, status, ageMs, waitMs) => {
  const createdAt = 1_000_000;
  const nowMs = createdAt + ageMs;
  assert.equal(busyWatcherHold(status, createdAt, nowMs), waitMs === null ? null : nowMs + waitMs);
});

it("a model alert survives a newer run that fell back too, unlike a thread event", () => {
  const shell = {
    latestRunId: "run:2",
    activeRunId: null,
    status: "completed",
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    providerInstanceId: "codex",
  } as never;
  assert.equal(
    alertIsStale(shell, "run:1", { providerInstanceId: "codex", newerRunSupersedes: false }),
    false,
  );
  assert.equal(alertIsStale(shell, "run:1", { providerInstanceId: "codex" }), true);
});

it.each([
  ["the same run", { latestRunId: "run:1", activeRunId: null, status: "failed" }, false],
  [
    "a newer run that is running",
    { latestRunId: "run:2", activeRunId: "run:2", status: "running" },
    true,
  ],
  [
    "a newer run that completed",
    { latestRunId: "run:2", activeRunId: null, status: "completed" },
    true,
  ],
  [
    "a newer run that failed again",
    { latestRunId: "run:2", activeRunId: null, status: "failed" },
    false,
  ],
  ["an archived thread", { latestRunId: "run:1", status: "failed", archivedAt: "x" }, true],
] as const)("alert staleness at delivery: %s -> %s", (_name, shell, stale) => {
  assert.equal(
    alertIsStale(
      { activeRunId: null, archivedAt: null, deletedAt: null, ...shell } as never,
      "run:1",
    ),
    stale,
  );
  assert.equal(alertIsStale(null, "run:1"), true);
});

it("auto-resume is expected only for a first limit on a resumable thread with a known reset", () => {
  const shell = {
    usageLimitResetAt: "2026-11-19T09:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    snoozedUntil: null,
  } as never;
  const nowMs = Date.parse("2026-11-19T04:00:00.000Z");
  const expects = (overrides: object) =>
    expectsAutoResume({ autoResumeEnabled: true, runWasResume: false, shell, nowMs, ...overrides });
  assert.equal(expects({}), true);
  assert.equal(expects({ autoResumeEnabled: false }), false);
  assert.equal(expects({ runWasResume: true }), false);
  assert.equal(expects({ shell: { ...(shell as object), usageLimitResetAt: null } }), false);
  assert.equal(expects({ shell: { ...(shell as object), settledOverride: "settled" } }), false);
  // The worker skips a child of a closed parent and waits out a snooze, so neither resumes in time.
  assert.equal(expects({ parentClosed: true }), false);
  const snoozedTo = (iso: string) => ({
    shell: { ...(shell as object), snoozedUntil: DateTime.makeUnsafe(iso) },
    graceMs: RESUME_GRACE_MS,
  });
  assert.equal(expects(snoozedTo("2026-11-19T09:10:00.000Z")), true);
  assert.equal(expects(snoozedTo("2026-11-19T12:00:00.000Z")), false);
});

it.effect("delivers a 20-thread storm to Lead as one message", () =>
  Effect.gen(function* () {
    const state = stormOf(20, {}, ["watcher", "webhook"]);
    const dispatched: Array<unknown> = [];
    const deps = {
      dispatch: (command: unknown) => Effect.sync(() => void dispatched.push(command)),
      call: () => Effect.void,
      sha256Hex: (identity: string) => Effect.succeed(`digest(${identity.length})`),
    } as never;
    const lead = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("lead") };
    const due = state.outbox.filter((entry) => entry.destination === "watcher");
    for (const entry of due) {
      yield* deliverAlertToWatcher(deps, entry.alert, lead, EnvironmentId.make("env"));
    }
    assert.equal(dispatched.length, 1);
    assert.include((dispatched[0] as { text: string }).text, "20 threads stopped");
  }),
);

it("a model alert is stale once its thread is settled or runs on another provider", () => {
  const base = {
    latestRunId: "run:1",
    activeRunId: null,
    status: "failed",
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    providerInstanceId: "magpie-primary-codex",
  } as never;
  const about = { providerInstanceId: "magpie-primary-codex" };
  assert.equal(alertIsStale(base, "run:1", about), false);
  assert.equal(
    alertIsStale({ ...(base as object), settledOverride: "settled" } as never, "run:1", about),
    true,
  );
  assert.equal(
    alertIsStale(
      { ...(base as object), providerInstanceId: "claudeAgent" } as never,
      "run:1",
      about,
    ),
    true,
  );
  // Thread events are not about a provider, and a settle is what some of them report.
  assert.equal(
    alertIsStale({ ...(base as object), settledOverride: "settled" } as never, "run:1"),
    false,
  );
});

it("a delegated child is replaced when its parent started a later one with the same task title", () => {
  const sibling = (overrides: object) =>
    ({
      title: " review pr 98 ",
      status: "running",
      activeRunId: "run:2",
      archivedAt: null,
      deletedAt: null,
      ...overrides,
    }) as never;
  const child = { title: "Review PR 98" };
  assert.equal(replacedBySibling(child, [sibling({})]), true);
  assert.equal(replacedBySibling(child, [sibling({ title: "Build ASUS" })]), false);
  assert.equal(replacedBySibling(child, []), false);
  // Templated siblings that also failed, or are gone, replace nothing.
  assert.equal(replacedBySibling(child, [sibling({ status: "failed", activeRunId: null })]), false);
  assert.equal(replacedBySibling(child, [sibling({ archivedAt: "x" })]), false);
});

it("a provider out of usage is tracked until its reset, and a healthy run clears it", () => {
  ProviderExhaustion.clear();
  assert.equal(ProviderExhaustion.until("magpie-primary-codex", 1_000), null);
  ProviderExhaustion.mark("magpie-primary-codex", 5_000);
  assert.equal(ProviderExhaustion.until("magpie-primary-codex", 1_000), 5_000);
  assert.equal(ProviderExhaustion.until("claudeAgent", 1_000), null);
  assert.equal(ProviderExhaustion.until("magpie-primary-codex", 5_000), null);
  ProviderExhaustion.mark("magpie-primary-codex", 9_000);
  ProviderExhaustion.clear("magpie-primary-codex");
  assert.equal(ProviderExhaustion.until("magpie-primary-codex", 1_000), null);
});

it("a quota reread clears exhaustion, then marks a vendor that is still out", () => {
  ProviderExhaustion.clear();
  ProviderExhaustion.mark("magpie-primary-codex", 5_000);
  ProviderExhaustion.reapply("magpie-primary-codex", () => {
    assert.equal(ProviderExhaustion.until("magpie-primary-codex", 1_000), null);
    return 9_000;
  });
  assert.equal(ProviderExhaustion.until("magpie-primary-codex", 1_000), 9_000);
  ProviderExhaustion.reapply("magpie-primary-codex", () => null);
  assert.equal(ProviderExhaustion.until("magpie-primary-codex", 1_000), null);
});

const linkAlert = (at: number): PeerLinkRenewalAlert => ({
  type: "peer-link-renewal",
  id: `peer-link-renewal:environment-box:${at}`,
  environmentId: "environment-a",
  environmentLabel: "primary-r720",
  linkedEnvironmentId: "environment-box",
  linkedLabel: "ASUS",
  linkSession: "peer-link:environment-box:1",
  expiresAt: "2026-12-19T00:00:00.000Z",
  detail: "ASUS did not answer.",
  occurredAt: DateTime.formatIso(DateTime.makeUnsafe(at)),
});

it("a link that keeps failing to renew alerts once, until it renews", () => {
  let state = EMPTY_MODEL_ALERT_STATE;
  const enqueued: Array<boolean> = [];
  const step = (
    outcome: Parameters<typeof recordLinkRenewal>[1],
    destinations: ReadonlyArray<"watcher" | "webhook"> = ["watcher", "webhook"],
  ) => {
    const result = recordLinkRenewal(state, outcome, destinations, 0);
    state = result.state;
    enqueued.push(result.enqueued);
  };
  // Every hourly sweep fails; only the first one queues anything.
  for (const at of [1, 2, 3]) step({ _tag: "failed", alert: linkAlert(at) });
  step({ _tag: "renewed", linkedEnvironmentId: "environment-box" });
  // A later failure after a renewal is news again.
  step({ _tag: "failed", alert: linkAlert(4) });
  assert.deepEqual(enqueued, [true, false, false, false, true]);
  assert.deepEqual(
    state.outbox.map((entry) => [entry.alert.id, entry.destination]),
    [
      ["peer-link-renewal:environment-box:1", "watcher"],
      ["peer-link-renewal:environment-box:1", "webhook"],
      ["peer-link-renewal:environment-box:4", "watcher"],
      ["peer-link-renewal:environment-box:4", "webhook"],
    ],
  );
  // Another link failing is its own alert.
  const other = recordLinkRenewal(
    state,
    { _tag: "failed", alert: { ...linkAlert(5), linkedEnvironmentId: "environment-air" } },
    ["watcher"],
    0,
  );
  assert.equal(other.enqueued, true);
  const message = watcherAlertMessage(linkAlert(1));
  assert.include(message, "Link alert from primary-r720");
  assert.include(message, "ASUS did not answer.");
});

it("a link alert counts only once queued, and only a delivered one keeps the link quiet", () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  // With nowhere to send it, nothing is marked, so the next sweep with a watcher alerts.
  const nowhere = recordLinkRenewal(
    EMPTY_MODEL_ALERT_STATE,
    { _tag: "failed", alert: linkAlert(1) },
    [],
    0,
  );
  assert.equal(nowhere.enqueued, false);
  assert.deepEqual(nowhere.state.reported, {});
  const queued = recordLinkRenewal(
    nowhere.state,
    { _tag: "failed", alert: linkAlert(2) },
    ["watcher"],
    0,
  );
  assert.equal(queued.enqueued, true);

  // Never delivered and gone from the outbox: the link alerts again.
  const expired = recordLinkRenewal(
    queued.state,
    { _tag: "failed", alert: linkAlert(3) },
    ["watcher"],
    WEEK + 1,
  );
  assert.equal(expired.enqueued, true);

  // Delivered: quiet past the outbox's week, until it renews.
  const delivered = afterDeliveryAttempt(queued.state, queued.state.outbox[0]!, true, 1);
  assert.equal(delivered.outbox.length, 0);
  const later = recordLinkRenewal(
    delivered,
    { _tag: "failed", alert: linkAlert(4) },
    ["watcher"],
    WEEK + 1,
  );
  assert.equal(later.enqueued, false);

  // Linking again names a new session, so its first failure is news.
  const relinked = recordLinkRenewal(
    delivered,
    { _tag: "failed", alert: { ...linkAlert(5), linkSession: "peer-link:environment-box:2" } },
    ["watcher"],
    2,
  );
  assert.equal(relinked.enqueued, true);
  // A renewal clears every session's record for that link.
  const renewed = recordLinkRenewal(
    relinked.state,
    { _tag: "renewed", linkedEnvironmentId: "environment-box" },
    [],
    3,
  );
  assert.deepEqual(renewed.state.reported, {});
});
