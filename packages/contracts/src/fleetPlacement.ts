import * as Schema from "effect/Schema";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Capability-gated launch intent, not a caller-authored admission decision. */
export const FleetPlacementIntent = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("auto"), clientRequestId: TrimmedNonEmptyString }),
  Schema.Struct({
    mode: Schema.Literal("pinned"),
    clientRequestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
  }),
]);
export type FleetPlacementIntent = typeof FleetPlacementIntent.Type;

export const FLEET_PLACEMENT_MIN_PROTOCOL = 2;
export const FLEET_PLACEMENT_UNAVAILABLE =
  "Fleet placement requires protocol 2 and a qualified native placement adapter; this server cannot accept the request. No local fallback is allowed.";
