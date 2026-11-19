import { assert, it } from "@effect/vitest";

import {
  afterDeliveryAttempt,
  EMPTY_MODEL_ALERT_STATE,
  type ModelAlert,
  recordModelAlert,
} from "./ModelAlertReactor.ts";

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
