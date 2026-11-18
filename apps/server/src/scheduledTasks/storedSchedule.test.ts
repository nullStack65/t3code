import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ScheduledTask,
  type ScheduledTaskPlacementPolicy,
  type ScheduledTaskSchedule,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { readStoredSchedule, writeOwnedSchedule } from "./storedSchedule.ts";

// The reader every build before owned tasks uses for `schedule_json`.
const decodeAsOlderBuild = Schema.decodeUnknownResult(
  Schema.fromJsonString(ScheduledTask.fields.schedule),
);

const policy: ScheduledTaskPlacementPolicy = {
  revision: 1,
  placement: "auto",
  originEnvironmentId: EnvironmentId.make("environment-origin"),
  destinations: [
    { environmentId: EnvironmentId.make("environment-origin"), linkIncarnation: null },
    { environmentId: EnvironmentId.make("environment-box"), linkIncarnation: "link-session-1" },
  ],
  runtimeModeCeiling: "approval-required",
  interactionModeCeiling: "default",
  acceptedVia: "native",
  acceptedAt: "2026-11-18T17:00:00.000Z",
};

const schedules: ReadonlyArray<ScheduledTaskSchedule> = [
  { type: "interval", everyMs: 60_000 },
  { type: "fixed_time", timeOfDay: "09:30", weekdays: [1, 3, 5] },
  { type: "once", runAt: "2026-12-01T09:00:00.000Z" },
  { type: "webhook", signature: null, maxDeliveryAgeMinutes: null },
];

describe("stored schedules", () => {
  it("reads every legacy flat schedule as local work", () => {
    for (const schedule of schedules) {
      const json = JSON.stringify(schedule);
      assert.isTrue(Result.isSuccess(decodeAsOlderBuild(json)));
      assert.deepStrictEqual(readStoredSchedule(json), { kind: "legacy", schedule });
    }
  });

  it("round-trips an owned task's schedule, incarnation and policy", () => {
    const schedule = { type: "interval", everyMs: 120_000 } as const;
    const json = writeOwnedSchedule({ schedule, incarnation: "incarnation-1", policy });
    assert.deepStrictEqual(readStoredSchedule(json), {
      kind: "owned",
      schedule,
      placement: { incarnation: "incarnation-1", policy },
    });
  });

  it("is refused by the reader older builds use, so they never run it as local work", () => {
    const json = writeOwnedSchedule({
      schedule: { type: "interval", everyMs: 60_000 },
      incarnation: "incarnation-1",
      policy,
    });
    assert.isTrue(Result.isFailure(decodeAsOlderBuild(json)));
  });

  it("keeps a newer version or an unreadable owned record as unsupported, never as legacy", () => {
    const owned = JSON.parse(
      writeOwnedSchedule({
        schedule: { type: "interval", everyMs: 60_000 },
        incarnation: "incarnation-1",
        policy,
      }),
    ) as Record<string, unknown>;
    for (const value of [
      { ...owned, version: 2 },
      { ...owned, format: "t3.scheduled-task.other" },
      { ...owned, policy: { ...policy, placement: "everywhere" } },
      { ...owned, incarnation: "" },
      // A legacy-looking schedule inside the family is still not legacy.
      { format: "t3.scheduled-task.placement", type: "interval", everyMs: 60_000 },
    ]) {
      assert.strictEqual(readStoredSchedule(JSON.stringify(value)).kind, "unsupported");
    }
  });

  it("leaves rows that are not schedules at all as malformed", () => {
    assert.strictEqual(readStoredSchedule("broken").kind, "malformed");
    assert.strictEqual(readStoredSchedule('{"type":"interval","everyMs":"x"}').kind, "malformed");
    assert.strictEqual(readStoredSchedule("[]").kind, "malformed");
  });
});
