import {
  ScheduledTask,
  ScheduledTaskPlacement,
  type ScheduledTaskPlacementPolicy,
  type ScheduledTaskSchedule,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * The stored `schedule_json` of a task an accepted placement owns. Its outer discriminator is
 * `format`, never a legacy schedule `type`: a reader that predates it fails to decode the row and
 * skips it, rather than reading the inner schedule as local work and dropping the policy.
 */
export const OWNED_SCHEDULE_FORMAT = "t3.scheduled-task.placement";
export const OWNED_SCHEDULE_VERSION = 1;

const OwnedScheduleEnvelopeV1 = Schema.Struct({
  format: Schema.Literal(OWNED_SCHEDULE_FORMAT),
  version: Schema.Literal(OWNED_SCHEDULE_VERSION),
  schedule: ScheduledTask.fields.schedule,
  incarnation: ScheduledTaskPlacement.fields.incarnation,
  policy: ScheduledTaskPlacement.fields.policy,
});
const OwnedScheduleEnvelopeV1Json = Schema.fromJsonString(OwnedScheduleEnvelopeV1);
const decodeOwnedV1 = Schema.decodeUnknownResult(OwnedScheduleEnvelopeV1);
const encodeOwnedV1 = Schema.encodeSync(OwnedScheduleEnvelopeV1Json);
const decodeLegacy = Schema.decodeUnknownResult(ScheduledTask.fields.schedule);

export type StoredSchedule =
  | { readonly kind: "legacy"; readonly schedule: ScheduledTaskSchedule }
  | {
      readonly kind: "owned";
      readonly schedule: ScheduledTaskSchedule;
      readonly placement: ScheduledTaskPlacement;
    }
  /** Stored by another version, or an owned record this version cannot read: kept, never run. */
  | { readonly kind: "unsupported"; readonly reason: string }
  /** Not a schedule at all; legacy rows like this keep their existing handling. */
  | { readonly kind: "malformed"; readonly cause: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function readStoredSchedule(json: string): StoredSchedule {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (cause) {
    return { kind: "malformed", cause };
  }
  if (isRecord(value) && "format" in value) {
    if (value.format !== OWNED_SCHEDULE_FORMAT || value.version !== OWNED_SCHEDULE_VERSION) {
      return {
        kind: "unsupported",
        reason: "This task was saved by another version of T3 Code and is kept unchanged here.",
      };
    }
    const owned = decodeOwnedV1(value);
    return Result.isSuccess(owned)
      ? {
          kind: "owned",
          schedule: owned.success.schedule,
          placement: { incarnation: owned.success.incarnation, policy: owned.success.policy },
        }
      : {
          kind: "unsupported",
          reason: "This task's automatic placement could not be read, so it is kept unchanged.",
        };
  }
  const legacy = decodeLegacy(value);
  return Result.isSuccess(legacy)
    ? { kind: "legacy", schedule: legacy.success }
    : { kind: "malformed", cause: legacy.failure };
}

/** The stored form of an owned task's schedule; only an accepted-placement writer uses it. */
export function writeOwnedSchedule(input: {
  readonly schedule: ScheduledTaskSchedule;
  readonly incarnation: string;
  readonly policy: ScheduledTaskPlacementPolicy;
}): string {
  return encodeOwnedV1({
    format: OWNED_SCHEDULE_FORMAT,
    version: OWNED_SCHEDULE_VERSION,
    schedule: input.schedule,
    incarnation: input.incarnation,
    policy: input.policy,
  });
}
