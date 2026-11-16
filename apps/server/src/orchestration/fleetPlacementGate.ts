import {
  FLEET_PLACEMENT_UNAVAILABLE,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

/** This protocol-1 source has no qualified peer launch adapter. Reject explicit
 * fleet intent at both ingress (before filesystem effects) and serialized engine
 * admission (also covers native callers). Do not reinterpret auto as local.
 */
export const requireFleetPlacementSupport = (
  command: ClientOrchestrationCommand | OrchestrationCommand,
) => {
  const intent =
    command.type === "thread.create"
      ? command.fleetPlacement
      : command.type === "thread.turn.start"
        ? command.bootstrap?.createThread?.fleetPlacement
        : undefined;
  return intent === undefined
    ? Effect.void
    : Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: FLEET_PLACEMENT_UNAVAILABLE,
        }),
      );
};
