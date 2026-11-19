import { assert, it } from "@effect/vitest";
import { EnvironmentId, type OrchestrationV2Run, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  afterDeliveryAttempt,
  deliverAlertToWatcher,
  EMPTY_MODEL_ALERT_STATE,
  type ModelAlert,
  modelAlertDestinations,
  modelAlertFor,
  recordModelAlert,
  recordThreadEvents,
  watcherAlertMessage,
} from "./ModelAlertReactor.ts";
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
    state.outbox.map((entry) => [entry.alert.runId, entry.destination]),
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

const eventAlert = (finding: ThreadFinding): ThreadEventAlert => ({
  type: "thread-event",
  kind: finding.kind,
  id: `env:thread:fleet:${finding.kind}:${finding.signature}`,
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
  occurredAt: "2026-11-19T03:00:00.000Z",
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
  // Recovery clears it. The same signature queues nothing while its first delivery still waits;
  // a new run reports at once.
  step(["stuck"], []);
  step(["stuck"], [finding("stuck", "run:1")]);
  step(["stuck"], [finding("stuck", "run:2")]);
  assert.deepEqual(enqueued, [true, false, true, false, false, false, false, true]);
  assert.deepEqual(
    state.outbox.map((entry) => entry.alert.id),
    [
      "env:thread:fleet:stuck:run:1",
      "env:thread:fleet:lane-ended:run:1",
      "env:thread:fleet:stuck:run:2",
    ],
  );
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
