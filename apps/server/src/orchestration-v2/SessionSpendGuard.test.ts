import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  checkLaunch,
  describeSpendStop,
  evaluateSpendGuard,
  evaluateThreadSpend,
  priceProviderTurns,
  rateForModel,
  spendGuardMarkers,
  spendGuardNoticeId,
  UNTITLED_LAUNCH_REFUSAL,
  workSignalAts,
  type SpendEntry,
  type SpendGuardInput,
  type SpendGuardMarker,
} from "./SessionSpendGuard.ts";
import { spendGuardNotice, wakeSettledThread } from "./SessionSpendGuardReactor.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

const rate = {
  inputCostPerToken: 1,
  outputCostPerToken: 2,
  cacheReadCostPerToken: 0.1,
};

const settings = {
  ...decodeSettings({}).sessionSpendGuard,
  idleFlagUsd: 3,
  idleStopUsd: 5,
  sessionCeilingUsd: 10,
};

const at = (iso: string) => DateTime.makeUnsafe(iso);

const priced = (createdAt: string, usd: number): SpendEntry => ({ createdAt, usd });

const marker = (
  kind: SpendGuardMarker["kind"],
  createdAt: string,
  reason: SpendGuardMarker["reason"] = "idle",
): SpendGuardMarker => ({ kind, reason, createdAt });

const evaluate = (overrides: Partial<SpendGuardInput> = {}) =>
  evaluateSpendGuard({
    spend: [],
    markers: [],
    workSignalAts: [],
    settings,
    ...overrides,
  });

describe("priceProviderTurns", () => {
  it("prices uncached input, cache read, output, and other usage", () => {
    expect(
      priceProviderTurns(
        [
          {
            startedAt: at("2026-01-01T00:00:00.000Z"),
            completedAt: at("2026-01-01T00:05:00.000Z"),
            turnTokenUsage: {
              usageScope: "main_agent",
              usageStatus: "complete",
              hasSubagents: true,
              inputTokens: 10,
              cachedInputTokens: 4,
              outputTokens: 2,
              otherUsage: { inputTokens: 1, outputTokens: 1 },
            },
          },
        ],
        rate,
      ),
    ).toEqual([{ createdAt: "2026-01-01T00:00:00.000Z", usd: 13.4 }]);
  });

  it("falls back to the context snapshot and skips a turn with no counts", () => {
    expect(
      priceProviderTurns(
        [
          {
            startedAt: at("2026-01-01T00:01:00.000Z"),
            completedAt: null,
            tokenUsage: {
              usedTokens: 9,
              inputTokens: 5,
              updatedAt: "2026-01-01T00:01:30.000Z",
            },
          },
          {
            startedAt: at("2026-01-01T00:02:00.000Z"),
            completedAt: null,
            turnTokenUsage: {
              usageScope: "main_agent",
              usageStatus: "unavailable",
              hasSubagents: false,
            },
          },
        ],
        rate,
      ),
    ).toEqual([{ createdAt: "2026-01-01T00:01:00.000Z", usd: 5 }]);
  });
});

describe("spendGuardMarkers", () => {
  it("reads only spend guard notices", () => {
    expect(
      spendGuardMarkers([
        {
          id: spendGuardNoticeId("thread-1", "stopped", "ceiling", "a") as never,
          type: "system_notice",
          startedAt: at("2026-01-01T00:01:00.000Z"),
        },
        {
          id: "server-recovery:thread-1" as never,
          type: "system_notice",
          startedAt: at("2026-01-01T00:02:00.000Z"),
        },
      ]),
    ).toEqual([marker("stopped", "2026-01-01T00:01:00.000Z", "ceiling")]);
  });
});

describe("evaluateSpendGuard", () => {
  it("counts idle spend only after the latest pull request or file-changing checkpoint", () => {
    const signals = workSignalAts({
      thread: {
        pullRequests: [
          { linkedAt: "2026-01-01T00:02:00.000Z", source: "manual" },
          { linkedAt: "2026-01-01T00:09:00.000Z", source: "stack-dismissed" },
        ] as never,
      },
      checkpoints: [
        { capturedAt: at("2026-01-01T00:03:00.000Z"), files: [{}] as never },
        { capturedAt: at("2026-01-01T00:08:00.000Z"), files: [] },
      ],
    });
    const result = evaluate({
      workSignalAts: signals,
      spend: [
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

  it("flags idle spend without stopping when mode is flag", () => {
    const result = evaluate({
      settings: { ...settings, mode: "flag" },
      spend: [priced("2026-01-01T00:01:00.000Z", 6)],
    });
    expect(result).toMatchObject({ level: "flag", stopReason: "idle", idleUsd: 6 });
  });

  it("stops for the session ceiling ahead of the idle limit", () => {
    const result = evaluate({
      spend: [priced("2026-01-01T00:01:00.000Z", 10)],
    });
    expect(result).toMatchObject({ level: "stop", stopReason: "ceiling", sessionUsd: 10 });
  });

  it("stops at the session ceiling when a recent pull request keeps idle spend under the idle limit", () => {
    const result = evaluate({
      workSignalAts: ["2026-01-01T00:02:00.000Z"],
      spend: [priced("2026-01-01T00:01:00.000Z", 6), priced("2026-01-01T00:03:00.000Z", 4)],
    });
    expect(result.idleUsd).toBe(4);
    expect(result.sessionUsd).toBe(10);
    expect(result.level).toBe("stop");
    expect(result.stopReason).toBe("ceiling");
  });

  it("does not stop or flag when the guard is off", () => {
    const result = evaluate({
      settings: { ...settings, mode: "off" },
      spend: [priced("2026-01-01T00:01:00.000Z", 20)],
    });
    expect(result).toMatchObject({ level: "ok", stopReason: null });
  });

  it("remembers a flag or stop only until the next idle boundary", () => {
    const idle = evaluate({
      workSignalAts: ["2026-01-01T00:02:00.000Z"],
      markers: [
        marker("flagged", "2026-01-01T00:01:00.000Z"),
        marker("stopped", "2026-01-01T00:01:30.000Z", "idle"),
        marker("stopped", "2026-01-01T00:03:00.000Z", "ceiling"),
        marker("flagged", "2026-01-01T00:04:00.000Z"),
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
      markers: [marker("flagged", "2026-01-01T00:03:00.000Z", "idle")],
      spend: [priced("2026-01-01T00:01:00.000Z", 6), priced("2026-01-01T00:04:00.000Z", 4)],
    });
    expect(flagged).toMatchObject({
      level: "flag",
      stopReason: "ceiling",
      flaggedSinceIdle: true,
      flaggedForCeiling: false,
      idleUsd: 4,
      sessionUsd: 10,
    });
    expect(spendGuardNotice(flagged, settings)).toMatchObject({
      kind: "flagged",
      reason: "ceiling",
    });
    const recorded = evaluate({
      settings: { ...settings, mode: "flag" },
      spend: [priced("2026-01-01T00:01:00.000Z", 10)],
      markers: [marker("flagged", "2026-01-01T00:02:00.000Z", "ceiling")],
    });
    expect(recorded.flaggedForCeiling).toBe(true);
    expect(recorded.stopReason).toBe("ceiling");
    expect(spendGuardNotice(recorded, settings)).toBeNull();
  });
});

describe("spendGuardNotice", () => {
  it("records each flag or stop once per window", () => {
    const stop = evaluate({ spend: [priced("2026-01-01T00:01:00.000Z", 6)] });
    expect(spendGuardNotice(stop, settings)).toMatchObject({ kind: "stopped", reason: "idle" });
    const recorded = evaluate({
      spend: [priced("2026-01-01T00:01:00.000Z", 6)],
      markers: [marker("stopped", "2026-01-01T00:02:00.000Z", "idle")],
    });
    expect(spendGuardNotice(recorded, settings)).toBeNull();
    const flag = evaluate({ spend: [priced("2026-01-01T00:01:00.000Z", 4)] });
    expect(spendGuardNotice(flag, settings)).toMatchObject({ kind: "flagged", reason: "idle" });
  });

  it("wakes a settled thread and leaves an active one alone", () => {
    const now = at("2026-01-01T00:05:00.000Z");
    const settled = { settledOverride: "settled", settledAt: now } as never;
    expect(wakeSettledThread(settled, now)).toMatchObject({
      settledOverride: null,
      settledAt: null,
      unsettledAt: now,
    });
    expect(wakeSettledThread({ settledOverride: null } as never, now)).toBeNull();
  });
});

describe("launch and stop copy", () => {
  const base = {
    title: "New thread",
    titlePending: false,
    hasOtherUserMessages: true,
    creationSource: "mcp" as const,
    mode: "enforce" as const,
  };

  it("refuses an untitled automated follow-up", () => {
    expect(checkLaunch(base)).toBe("untitled");
    expect(checkLaunch({ ...base, creationSource: "server" })).toBe("untitled");
    expect(checkLaunch({ ...base, title: "Named thread" })).toBeNull();
    expect(checkLaunch({ ...base, titlePending: true })).toBeNull();
    expect(checkLaunch({ ...base, hasOtherUserMessages: false })).toBeNull();
    expect(checkLaunch({ ...base, creationSource: "web" })).toBeNull();
    expect(checkLaunch({ ...base, mode: "flag" })).toBeNull();
  });

  it("describes how to continue", () => {
    const evaluation = evaluate({ spend: [priced("2026-01-01T00:01:00.000Z", 6)] });
    expect(describeSpendStop(evaluation, settings)).toContain("$6.00");
    expect(describeSpendStop(evaluation, settings)).toContain("$5.00");
    expect(UNTITLED_LAUNCH_REFUSAL).toContain("default title");
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
    const evaluation = evaluateThreadSpend(
      {
        thread: {
          pullRequests: [],
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "custom-model" },
        },
        providerTurns: [
          {
            startedAt: at("2026-01-01T00:01:00.000Z"),
            completedAt: null,
            tokenUsage: { usedTokens: 2, inputTokens: 2, updatedAt: "2026-01-01T00:01:00.000Z" },
          },
        ],
        checkpoints: [],
        turnItems: [],
      },
      decoded,
    );
    expect(evaluation.sessionUsd).toBe(2);
    expect(
      rateForModel("missing", decoded.usagePriceOverrides, decoded.sessionSpendGuard.fallbackRate)
        .inputCostPerToken,
    ).toBe(10 / 1_000_000);
  });
});
