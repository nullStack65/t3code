import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveSafeTaskPrompt } from "./delegatedTaskModes.ts";

describe("resolveSafeTaskPrompt (CLO-1099)", () => {
  it.effect("accepts a clean delegated task prompt", () =>
    Effect.gen(function* () {
      const prompt = yield* resolveSafeTaskPrompt({
        task: "Audit the webhook route handler and add unit tests.",
        role: "review",
      });
      assert.include(prompt, "Act as the review sub-agent");
      assert.include(prompt, "Audit the webhook route handler");
    }),
  );

  it.effect("refuses a delegated task prompt containing a fake API key", () =>
    Effect.gen(function* () {
      const fakeKey = `sk-${"A1b2C3d4E5f6G7h8I9j0".repeat(2)}`;
      const exit = yield* Effect.exit(
        resolveSafeTaskPrompt({
          task: `Call the service using ${fakeKey}`,
        }),
      );
      assert.isTrue(exit._tag === "Failure");
    }),
  );

  it.effect("refuses a delegated task prompt containing an inline password", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        resolveSafeTaskPrompt({
          task: "Connect with password=hunter2 to verify staging",
        }),
      );
      assert.isTrue(exit._tag === "Failure");
    }),
  );
});
