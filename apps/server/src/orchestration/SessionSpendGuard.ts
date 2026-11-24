import type {
  ClientSurface,
  OrchestrationCheckpointSummary,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ServerSettings,
  SessionSpendGuardSettings,
  ThreadExecutionScope,
  ThreadPullRequestLink,
  UsageModelPriceOverride,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import { createOverrideRateTable, lookupRate, type ModelRate } from "../usage/usagePricing.ts";
import { DEFAULT_THREAD_TITLE } from "./threadTitles.ts";

export const SPEND_GUARD_FLAGGED_KIND = "spend-guard.flagged";
export const SPEND_GUARD_STOPPED_KIND = "spend-guard.stopped";
const SPEND_GUARD_RELEASED_KIND = "spend-guard.released";
export const CONTEXT_WINDOW_KIND = "context-window.updated";

export const SPEND_GUARD_ACTIVITY_KINDS = [
  CONTEXT_WINDOW_KIND,
  SPEND_GUARD_FLAGGED_KIND,
  SPEND_GUARD_STOPPED_KIND,
  SPEND_GUARD_RELEASED_KIND,
] as const;

export type SpendGuardActivity = Pick<
  OrchestrationThreadActivity,
  "kind" | "payload" | "createdAt" | "sequence"
>;

export type SpendGuardLevel = "ok" | "flag" | "stop";
export type SpendGuardStopReason = "idle" | "ceiling";

export interface SpendGuardEvaluation {
  readonly level: SpendGuardLevel;
  readonly stopReason: SpendGuardStopReason | null;
  readonly sessionUsd: number;
  readonly idleUsd: number;
  readonly idleSince: string | null;
  readonly flaggedSinceIdle: boolean;
  readonly flaggedForCeiling: boolean;
  readonly stoppedSinceIdle: boolean;
  readonly stoppedForCeiling: boolean;
}

export interface SpendGuardInput {
  readonly activities: ReadonlyArray<SpendGuardActivity>;
  readonly workSignalAts: ReadonlyArray<string>;
  readonly rate: ModelRate;
  readonly settings: SessionSpendGuardSettings;
}

export function rateForModel(
  model: string,
  overrides: Readonly<Record<string, UsageModelPriceOverride>>,
  fallback: UsageModelPriceOverride,
): ModelRate {
  return (
    lookupRate(createOverrideRateTable(overrides), model) ??
    createOverrideRateTable({ fallback }).get("fallback")!
  );
}

export function workSignalAts(thread: {
  readonly pullRequests: ReadonlyArray<Pick<ThreadPullRequestLink, "linkedAt" | "source">>;
  readonly checkpoints: ReadonlyArray<
    Pick<OrchestrationCheckpointSummary, "completedAt" | "files">
  >;
}): ReadonlyArray<string> {
  return [
    ...thread.pullRequests
      .filter((link) => link.source !== "stack-dismissed")
      .map((link) => link.linkedAt),
    ...thread.checkpoints
      .filter((checkpoint) => checkpoint.files.length > 0)
      .map((checkpoint) => checkpoint.completedAt),
  ];
}

function count(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function orderActivities(
  activities: ReadonlyArray<SpendGuardActivity>,
): ReadonlyArray<SpendGuardActivity> {
  return activities.toSorted((left, right) =>
    left.sequence !== undefined && right.sequence !== undefined
      ? left.sequence - right.sequence
      : left.createdAt.localeCompare(right.createdAt),
  );
}

export function priceSnapshots(
  activities: ReadonlyArray<SpendGuardActivity>,
  rate: ModelRate,
): ReadonlyArray<{ readonly createdAt: string; readonly usd: number }> {
  const priced: Array<{ createdAt: string; usd: number }> = [];
  let previousTotal: number | undefined;
  for (const activity of orderActivities(activities)) {
    if (activity.kind !== CONTEXT_WINDOW_KIND || !Predicate.isObject(activity.payload)) continue;
    const payload = activity.payload as Record<string, unknown>;
    const total = count(payload, "totalProcessedTokens");
    if (total !== undefined && total === previousTotal) continue;
    const delta =
      total === undefined
        ? undefined
        : previousTotal === undefined || total < previousTotal
          ? total
          : total - previousTotal;
    if (total !== undefined) previousTotal = total;
    const lastInput = count(payload, "lastInputTokens");
    const lastOutput = count(payload, "lastOutputTokens");
    let usd: number;
    if (lastInput !== undefined || lastOutput !== undefined) {
      const input = lastInput ?? 0;
      const cached = Math.min(count(payload, "lastCachedInputTokens") ?? 0, input);
      usd =
        (input - cached) * rate.inputCostPerToken +
        cached * rate.cacheReadCostPerToken +
        (lastOutput ?? 0) * rate.outputCostPerToken;
    } else if (delta !== undefined) {
      usd = delta * rate.cacheReadCostPerToken;
    } else {
      continue;
    }
    if (usd > 0) priced.push({ createdAt: activity.createdAt, usd });
  }
  return priced;
}

function latest(values: ReadonlyArray<string>): string | null {
  return values.reduce<string | null>(
    (current, value) => (current === null || value > current ? value : current),
    null,
  );
}

export function evaluateSpendGuard(input: SpendGuardInput): SpendGuardEvaluation {
  const releasedAt = latest(
    input.activities
      .filter((activity) => activity.kind === SPEND_GUARD_RELEASED_KIND)
      .map((activity) => activity.createdAt),
  );
  const idleSince = latest([...(releasedAt === null ? [] : [releasedAt]), ...input.workSignalAts]);
  const after = (since: string | null) => (createdAt: string) =>
    since === null || createdAt > since;
  const afterRelease = after(releasedAt);
  const afterIdle = after(idleSince);
  const spend = priceSnapshots(input.activities, input.rate);
  const sessionUsd = spend
    .filter((entry) => afterRelease(entry.createdAt))
    .reduce((sum, entry) => sum + entry.usd, 0);
  const idleUsd = spend
    .filter((entry) => afterIdle(entry.createdAt))
    .reduce((sum, entry) => sum + entry.usd, 0);
  const guardActivities = (kind: string, since: (createdAt: string) => boolean) =>
    input.activities.filter((activity) => activity.kind === kind && since(activity.createdAt));
  const stoppedPayloadReason = (activity: SpendGuardActivity) =>
    Predicate.isObject(activity.payload)
      ? (activity.payload as Record<string, unknown>).reason
      : undefined;
  const flaggedSinceIdle = guardActivities(SPEND_GUARD_FLAGGED_KIND, afterIdle).length > 0;
  const flaggedForCeiling = guardActivities(SPEND_GUARD_FLAGGED_KIND, afterRelease).some(
    (activity) => stoppedPayloadReason(activity) === "ceiling",
  );
  const stoppedSinceIdle = guardActivities(SPEND_GUARD_STOPPED_KIND, afterIdle).some(
    (activity) => stoppedPayloadReason(activity) === "idle",
  );
  const stoppedForCeiling = guardActivities(SPEND_GUARD_STOPPED_KIND, afterRelease).some(
    (activity) => stoppedPayloadReason(activity) === "ceiling",
  );
  const { mode, idleFlagUsd, idleStopUsd, sessionCeilingUsd } = input.settings;
  const base = {
    sessionUsd,
    idleUsd,
    idleSince,
    flaggedSinceIdle,
    flaggedForCeiling,
    stoppedSinceIdle,
    stoppedForCeiling,
  };
  if (mode === "off") return { ...base, level: "ok", stopReason: null };
  const stopReason: SpendGuardStopReason | null =
    sessionUsd >= sessionCeilingUsd ? "ceiling" : idleUsd >= idleStopUsd ? "idle" : null;
  if (stopReason !== null && mode === "enforce") {
    return { ...base, level: "stop", stopReason };
  }
  if (stopReason !== null || idleUsd >= idleFlagUsd) {
    return { ...base, level: "flag", stopReason };
  }
  return { ...base, level: "ok", stopReason: null };
}

export function evaluateThreadSpend(
  thread: Pick<
    OrchestrationThread,
    "activities" | "pullRequests" | "checkpoints" | "modelSelection"
  >,
  settings: Pick<ServerSettings, "sessionSpendGuard" | "usagePriceOverrides">,
): SpendGuardEvaluation {
  return evaluateSpendGuard({
    activities: thread.activities,
    workSignalAts: workSignalAts(thread),
    rate: rateForModel(
      thread.modelSelection.model,
      settings.usagePriceOverrides,
      settings.sessionSpendGuard.fallbackRate,
    ),
    settings: settings.sessionSpendGuard,
  });
}

export function describeSpendStop(
  evaluation: SpendGuardEvaluation,
  settings: SessionSpendGuardSettings,
): string {
  const usd = (value: number) => `$${value.toFixed(2)}`;
  return evaluation.stopReason === "ceiling"
    ? `This thread has spent about ${usd(evaluation.sessionUsd)}, past its ${usd(settings.sessionCeilingUsd)} session ceiling. Raise sessionSpendGuard.sessionCeilingUsd to continue.`
    : `This thread has spent about ${usd(evaluation.idleUsd)} with no linked pull request or file-changing turn, past the ${usd(settings.idleStopUsd)} idle limit. Link a pull request or change files to continue.`;
}

export type LaunchRefusal = "untitled" | "ownerless";

export interface LaunchCheckInput {
  readonly title: string;
  readonly titleSeed: string | undefined;
  readonly executionScope: ThreadExecutionScope | null | undefined;
  readonly hasOtherUserMessages: boolean;
  readonly clientSurface: ClientSurface | undefined;
  readonly mode: SessionSpendGuardSettings["mode"];
}

const INTERACTIVE_SURFACES: ReadonlySet<ClientSurface> = new Set(["web", "desktop", "mobile"]);

export function checkLaunch(input: LaunchCheckInput): LaunchRefusal | null {
  const interactive =
    input.clientSurface !== undefined && INTERACTIVE_SURFACES.has(input.clientSurface);
  if (input.mode !== "enforce" || interactive) return null;
  if (input.executionScope === null || input.executionScope === undefined) return "ownerless";
  const untitled = input.title.trim() === "" || input.title.trim() === DEFAULT_THREAD_TITLE;
  if (untitled && input.titleSeed === undefined && input.hasOtherUserMessages) return "untitled";
  return null;
}

export function describeLaunchRefusal(refusal: LaunchRefusal): string {
  return refusal === "ownerless"
    ? "Automated turns are refused on a thread with no execution scope, such as an imported session or a legacy thread. Continue it from the T3 app, or launch a new thread with an owner."
    : "Automated turns are refused on a thread that still has the default title after its first turn. Give the thread a title, then send again.";
}
