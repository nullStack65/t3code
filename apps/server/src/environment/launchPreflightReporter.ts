/**
 * Production reporter for launch-preflight warnings.
 *
 * The composition root injects this into `ProviderService`, which calls it for
 * every warning it surfaces. It appends a `launch.preflight` thread activity
 * through the real orchestration engine, so a warning reaches the same client
 * subscription a normal thread activity does. It never fails a launch: a
 * failed append returns `false` so the caller can keep the pending notice.
 *
 * @module launchPreflightReporter
 */
import { CommandId, EventId, type ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { LaunchPreflightFindingCode } from "./LaunchPreflight.ts";

export interface LaunchPreflightWarningReportInput {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly code: LaunchPreflightFindingCode;
  readonly message: string;
}

export const makeLaunchPreflightWarningReporter =
  (orchestrationEngine: OrchestrationEngineShape, crypto: Crypto.Crypto) =>
  (input: LaunchPreflightWarningReportInput): Effect.Effect<boolean, never> =>
    Effect.gen(function* () {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        threadId: input.threadId,
        activity: {
          id: EventId.make(yield* crypto.randomUUIDv4),
          tone: "error",
          kind: "launch.preflight",
          summary: input.message,
          payload: { code: input.code, cwd: input.cwd },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
      return true;
    }).pipe(Effect.catchCause(() => Effect.succeed(false)));
