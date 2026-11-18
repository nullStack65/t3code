import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTaskListResult,
  ScheduledTaskPlacementPolicy,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("accepts a one-time run only with an offset", () => {
    for (const runAt of ["2026-11-03T09:00Z", "2026-11-03T09:00:00.000-08:00"]) {
      expect(decodeUpsertSchedule({ type: "once", runAt })).toEqual({ type: "once", runAt });
    }
    for (const runAt of [
      "2026-11-03T09:00",
      "2026-13-03T09:00Z",
      "2026-02-30T09:00Z",
      "9999-12-31T23:30-01:00",
      "0000-01-01T00:00+00:01",
      "tomorrow",
    ]) {
      expect(() => decodeUpsertSchedule({ type: "once", runAt })).toThrow();
    }
  });
});

it.each(["literal", " ", "\t\n", "{{body.bad", "{{unknown.field}}"])(
  "rejects invalid dedupe template %s",
  (replayKey) => {
    expect(() => decodeUpsertSchedule({ type: "webhook", dedupe: { replayKey } })).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "webhook", dedupe: { coalesceKey: replayKey } }),
    ).toThrow();
  },
);
describe("webhook filters", () => {
  const accepts = (filters: unknown) => {
    try {
      decodeUpsertSchedule({ type: "webhook", filters });
      return true;
    } catch {
      return false;
    }
  };

  it("rejects empty or unknown paths, unknown ops, and values that do not fit the op", () => {
    expect(accepts([{ path: "", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "  ", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "request", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "header.x-github-event", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: "opened" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: [] }])).toBe(false);
    for (const value of ["", " opened", "opened ", "a,b"]) {
      expect(accepts([{ path: "body.action", op: "in", value: [value] }])).toBe(false);
    }
    expect(accepts([{ path: "body.label.name", op: "in", value: ["needs review"] }])).toBe(true);
    expect(accepts([{ path: "body.action", op: "equals" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "matches", value: "^opened$" }])).toBe(false);
  });
});

describe("owned task contracts", () => {
  const decodeList = Schema.decodeUnknownSync(ScheduledTaskListResult);
  const decodePolicy = Schema.decodeUnknownSync(ScheduledTaskPlacementPolicy);
  const policy = {
    revision: 1,
    placement: "auto",
    originEnvironmentId: "environment-origin",
    destinations: [{ environmentId: "environment-box", linkIncarnation: "link-1" }],
    runtimeModeCeiling: "full-access",
    interactionModeCeiling: "default",
    acceptedVia: "mcp",
    acceptedAt: "2026-11-18T12:00:00.000Z",
  };

  it("reads a list without unsupported records, as older servers send it", () => {
    expect(decodeList({ tasks: [] })).toEqual({ tasks: [] });
  });

  it("keeps unsupported records apart from tasks", () => {
    const unsupported = {
      id: "task:future",
      title: "Future",
      projectId: "project:test",
      createdAt: "2026-11-18T12:00:00.000Z",
      updatedAt: "2026-11-18T12:00:00.000Z",
      reason: "Saved by another version.",
    };
    expect(decodeList({ tasks: [], unsupported: [unsupported] }).unsupported).toEqual([
      unsupported,
    ]);
  });

  it("accepts only an automatic placement with a positive revision", () => {
    expect(decodePolicy(policy)).toEqual(policy);
    expect(() => decodePolicy({ ...policy, placement: "manual" })).toThrow();
    expect(() => decodePolicy({ ...policy, revision: 0 })).toThrow();
    expect(() => decodePolicy({ ...policy, acceptedVia: "label" })).toThrow();
  });
});
