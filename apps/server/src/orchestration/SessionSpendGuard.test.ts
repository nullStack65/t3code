import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { DEFAULT_THREAD_TITLE } from "./threadTitles.ts";
import {
  checkLaunch,
  describeLaunchRefusal,
  describeSpendStop,
  evaluateSpendGuard,
  evaluateThreadSpend,
  priceSnapshots,
  rateForModel,
  workSignalAts,
  type SpendGuardActivity,
  type SpendGuardInput,
} from "./SessionSpendGuard.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

const rate = {
  inputCostPerToken: 1,
  outputCostPerToken: 2,
  cacheReadCostPerToken: 0.1,
  cacheCreationCostPerToken: 3,
};

const settings = {
  ...decodeSettings({}).sessionSpendGuard,
  idleFlagUsd: 3,
  idleStopUsd: 5,
  sessionCeilingUsd: 10,
};

const activity = (
  kind: string,
  createdAt: string,
  payload: SpendGuardActivity["payload"] = null,
  sequence?: number,
): SpendGuardActivity => ({ kind, createdAt, payload, sequence });

const priced = (createdAt: string, usdTokens: number, sequence?: number): SpendGuardActivity =>
  activity(
    "context-window.updated",
    createdAt,
    { totalProcessedTokens: usdTokens, lastInputTokens: usdTokens },
    sequence,
  );

const evaluate = (overrides: Partial<SpendGuardInput> = {}) =>
  evaluateSpendGuard({
    activities: [],
    workSignalAts: [],
    rate,
    settings,
    ...overrides,
  });

describe("priceSnapshots", () => {
  it("prices the latest uncached input, cache read, and output", () => {
    expect(
      priceSnapshots(
        [
          activity("context-window.updated", "2026-01-01T00:00:00.000Z", {
            totalProcessedTokens: 100,
            lastInputTokens: 10,
            lastCachedInputTokens: 4,
            lastOutputTokens: 2,
          }),
        ],
        rate,
      ),
    ).toEqual([{ createdAt: "2026-01-01T00:00:00.000Z", usd: 10.4 }]);
  });

  it("prices a token delta at the cache-read rate and skips a repeated total", () => {
    expect(
      priceSnapshots(
        [
          activity("context-window.updated", "2026-01-01T00:00:00.000Z", {
            totalProcessedTokens: 100,
          }),
          activity("context-window.updated", "2026-01-01T00:01:00.000Z", {
            totalProcessedTokens: 100,
            lastInputTokens: 9,
          }),
          activity("context-window.updated", "2026-01-01T00:02:00.000Z", {
            totalProcessedTokens: 150,
          }),
          activity("context-window.updated", "2026-01-01T00:03:00.000Z", {
            totalProcessedTokens: 40,
          }),
        ],
        rate,
      ),
    ).toEqual([
      { createdAt: "2026-01-01T00:00:00.000Z", usd: 10 },
      { createdAt: "2026-01-01T00:02:00.000Z", usd: 5 },
      { createdAt: "2026-01-01T00:03:00.000Z", usd: 4 },
    ]);
  });

  it("orders snapshots by sequence when both sides have one", () => {
    expect(
      priceSnapshots(
        [
          activity(
            "context-window.updated",
            "2026-01-01T00:02:00.000Z",
            { lastOutputTokens: 1 },
            2,
          ),
          activity(
            "context-window.updated",
            "2026-01-01T00:03:00.000Z",
            { lastOutputTokens: 1 },
            1,
          ),
        ],
        rate,
      ).map((entry) => entry.createdAt),
    ).toEqual(["2026-01-01T00:03:00.000Z", "2026-01-01T00:02:00.000Z"]);
  });
});

describe("evaluateSpendGuard", () => {
  it("counts idle spend only after the latest pull request or file-changing checkpoint", () => {
    const signals = workSignalAts({
      pullRequests: [
        { linkedAt: "2026-01-01T00:02:00.000Z", source: "manual" },
        { linkedAt: "2026-01-01T00:09:00.000Z", source: "stack-dismissed" },
      ],
      checkpoints: [
        { completedAt: "2026-01-01T00:03:00.000Z", files: ["src/app.ts"] },
        { completedAt: "2026-01-01T00:08:00.000Z", files: [] },
      ],
    });
    const result = evaluate({
      workSignalAts: signals,
      activities: [
        priced("2026-01-01T00:01:00.000Z", 2),
        priced("2026-01-01T00:02:30.000Z", 1),
        priced("2026-01-01T00:04:00.000Z", 6),
      ],
    });
    expect(result.idleSince).toBe("2026-01-01T00:03:00.000Z");
    expect(result.sessionUsd).toBe(9);
    expect(result.idleUsd).toBe(6);
    expect(result.level).toBe("stop");
    expect(result.stopReason).toBe("idle");
  });

  it("starts a new session after spend-guard.released", () => {
    const result = evaluate({
      activities: [
        priced("2026-01-01T00:01:00.000Z", 9),
        activity("spend-guard.released", "2026-01-01T00:02:00.000Z"),
        priced("2026-01-01T00:03:00.000Z", 2),
      ],
    });
    expect(result.sessionUsd).toBe(2);
    expect(result.idleUsd).toBe(2);
    expect(result.level).toBe("ok");
  });

  it("flags idle spend without stopping when mode is flag", () => {
    const result = evaluate({
      settings: { ...settings, mode: "flag" },
      activities: [priced("2026-01-01T00:01:00.000Z", 6)],
    });
    expect(result).toMatchObject({ level: "flag", stopReason: "idle", idleUsd: 6 });
  });

  it("stops for the session ceiling ahead of the idle limit", () => {
    const result = evaluate({
      activities: [priced("2026-01-01T00:01:00.000Z", 10)],
    });
    expect(result).toMatchObject({ level: "stop", stopReason: "ceiling", sessionUsd: 10 });
  });

  it("stops at the session ceiling when a recent pull request keeps idle spend under the idle limit", () => {
    const result = evaluate({
      workSignalAts: ["2026-01-01T00:02:00.000Z"],
      activities: [priced("2026-01-01T00:01:00.000Z", 6), priced("2026-01-01T00:03:00.000Z", 4)],
    });
    expect(result.idleUsd).toBe(4);
    expect(result.sessionUsd).toBe(10);
    expect(result.level).toBe("stop");
    expect(result.stopReason).toBe("ceiling");
  });

  it("does not stop or flag when the guard is off", () => {
    const result = evaluate({
      settings: { ...settings, mode: "off" },
      activities: [priced("2026-01-01T00:01:00.000Z", 20)],
    });
    expect(result).toMatchObject({ level: "ok", stopReason: null });
  });

  it("remembers a flag or stop only until the next idle boundary", () => {
    const idle = evaluate({
      workSignalAts: ["2026-01-01T00:02:00.000Z"],
      activities: [
        activity("spend-guard.flagged", "2026-01-01T00:01:00.000Z"),
        activity("spend-guard.stopped", "2026-01-01T00:01:30.000Z", { reason: "idle" }),
        activity("spend-guard.stopped", "2026-01-01T00:03:00.000Z", { reason: "ceiling" }),
        activity("spend-guard.flagged", "2026-01-01T00:04:00.000Z"),
      ],
    });
    expect(idle.flaggedSinceIdle).toBe(true);
    expect(idle.stoppedSinceIdle).toBe(false);
    expect(idle.stoppedForCeiling).toBe(true);
    expect(idle.flaggedForCeiling).toBe(false);
  });

  it("keeps a ceiling flag visible when an earlier idle flag is already recorded", () => {
    const flagged = evaluate({
      settings: { ...settings, mode: "flag" },
      workSignalAts: ["2026-01-01T00:02:00.000Z"],
      activities: [
        activity("spend-guard.flagged", "2026-01-01T00:03:00.000Z", { reason: "idle" }),
        priced("2026-01-01T00:01:00.000Z", 6),
        priced("2026-01-01T00:04:00.000Z", 4),
      ],
    });
    expect(flagged).toMatchObject({
      level: "flag",
      stopReason: "ceiling",
      flaggedSinceIdle: true,
      flaggedForCeiling: false,
      idleUsd: 4,
      sessionUsd: 10,
    });
    const recorded = evaluate({
      settings: { ...settings, mode: "flag" },
      activities: [
        priced("2026-01-01T00:01:00.000Z", 10),
        activity("spend-guard.flagged", "2026-01-01T00:02:00.000Z", { reason: "ceiling" }),
      ],
    });
    expect(recorded.flaggedForCeiling).toBe(true);
    expect(recorded.stopReason).toBe("ceiling");
  });
});

describe("launch and stop copy", () => {
  const base = {
    title: DEFAULT_THREAD_TITLE,
    titleSeed: undefined,
    executionScope: "coding" as const,
    hasOtherUserMessages: true,
    clientSurface: undefined,
    mode: "enforce" as const,
  };

  it("refuses an untitled or ownerless automated follow-up", () => {
    expect(checkLaunch(base)).toBe("untitled");
    expect(checkLaunch({ ...base, executionScope: null, hasOtherUserMessages: false })).toBe(
      "ownerless",
    );
    expect(checkLaunch({ ...base, title: "Named thread" })).toBeNull();
    expect(checkLaunch({ ...base, titleSeed: "seed" })).toBeNull();
    expect(checkLaunch({ ...base, hasOtherUserMessages: false })).toBeNull();
    expect(checkLaunch({ ...base, clientSurface: "desktop" })).toBeNull();
    expect(checkLaunch({ ...base, clientSurface: "cli" })).toBe("untitled");
    expect(checkLaunch({ ...base, mode: "flag" })).toBeNull();
  });

  it("describes how to continue", () => {
    const evaluation = evaluate({ activities: [priced("2026-01-01T00:01:00.000Z", 6)] });
    expect(describeSpendStop(evaluation, settings)).toContain("$6.00");
    expect(describeSpendStop(evaluation, settings)).toContain("$5.00");
    expect(describeLaunchRefusal("untitled")).toContain("default title");
    expect(describeLaunchRefusal("ownerless")).toContain("execution scope");
  });
});

describe("evaluateThreadSpend", () => {
  it("uses the model override and otherwise the fallback rate", () => {
    const decoded = decodeSettings({
      sessionSpendGuard: { idleStopUsd: 1, sessionCeilingUsd: 100 },
      usagePriceOverrides: {
        "custom-model": {
          inputCostPerMillionTokens: 1_000_000,
          outputCostPerMillionTokens: 0,
        },
      },
    });
    const thread = {
      activities: [priced("2026-01-01T00:01:00.000Z", 2)],
      pullRequests: [],
      checkpoints: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "custom-model",
      },
    };
    expect(evaluateThreadSpend(thread, decoded).sessionUsd).toBe(2);
    expect(
      rateForModel("missing", decoded.usagePriceOverrides, decoded.sessionSpendGuard.fallbackRate)
        .inputCostPerToken,
    ).toBe(10 / 1_000_000);
  });
});
