import {
  CommandId,
  EnvironmentId,
  FLEET_PLACEMENT_UNAVAILABLE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { requireFleetPlacementSupport } from "./fleetPlacementGate.ts";

const create: Extract<ClientOrchestrationCommand, { type: "thread.create" }> = {
  type: "thread.create",
  commandId: CommandId.make("gate"),
  threadId: ThreadId.make("gate"),
  projectId: ProjectId.make("synthetic"),
  title: "Synthetic",
  modelSelection: { instanceId: ProviderInstanceId.make("synthetic"), model: "synthetic" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: "2026-11-16T00:00:00.000Z",
};
it.effect(
  "rejects auto and pinned fleet intent before requiring filesystem/provider services",
  () =>
    Effect.gen(function* () {
      for (const fleetPlacement of [
        { mode: "auto", clientRequestId: "stable-auto" } as const,
        {
          mode: "pinned",
          clientRequestId: "stable-pinned",
          environmentId: EnvironmentId.make("remote"),
        } as const,
      ]) {
        const rejected = yield* Effect.result(
          requireFleetPlacementSupport({ ...create, fleetPlacement }),
        );
        expect(rejected._tag).toBe("Failure");
        if (rejected._tag === "Failure")
          expect(rejected.failure.detail).toBe(FLEET_PLACEMENT_UNAVAILABLE);
      }
      yield* requireFleetPlacementSupport(create);
    }),
);
