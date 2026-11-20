import type {
  OrchestrationV2AppThread,
  OrchestrationV2Checkpoint,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderTurn,
  OrchestrationV2TurnItem,
  ServerSettings,
  SessionSpendGuardSettings,
  UsageModelPriceOverride,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { createOverrideRateTable, lookupRate, type ModelRate } from "../usage/usagePricing.ts";

export const SPEND_GUARD_FLAGGED_KIND = "flagged";
export const SPEND_GUARD_STOPPED_KIND = "stopped";
const SPEND_GUARD_NOTICE_PREFIX = "spend-guard";
export const SPEND_GUARD_REFUSAL_TITLE = "Turn refused by the session spend guard";

export type SpendGuardLevel = "ok" | "flag" | "stop";
export type SpendGuardStopReason = "idle" | "ceiling";
export type SpendGuardMarkerKind =
  | typeof SPEND_GUARD_FLAGGED_KIND
  | typeof SPEND_GUARD_STOPPED_KIND;

export type SpendRate = Pick<
  ModelRate,
  "inputCostPerToken" | "outputCostPerToken" | "cacheReadCostPerToken"
>;

export interface SpendEntry {
  readonly createdAt: string;
  readonly usd: number;
}

export interface SpendGuardMarker {
  readonly kind: SpendGuardMarkerKind;
  readonly reason: SpendGuardStopReason;
  readonly createdAt: string;
}

export interface SpendGuardEvaluation {
  readonly level: SpendGuardLevel;
  readonly stopReason: SpendGuardStopReason | null;
  readonly sessionUsd: number;
  readonly idleUsd: number;
  readonly idleSince: string | null;
  readonly flaggedSinceIdle: boolean;
  readonly stoppedSinceIdle: boolean;
  readonly stoppedForCeiling: boolean;
}

export interface SpendGuardInput {
  readonly spend: ReadonlyArray<SpendEntry>;
  readonly markers: ReadonlyArray<SpendGuardMarker>;
  readonly workSignalAts: ReadonlyArray<string>;
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

export function workSignalAts(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "pullRequests">;
  readonly checkpoints: ReadonlyArray<Pick<OrchestrationV2Checkpoint, "capturedAt" | "files">>;
}): ReadonlyArray<string> {
  return [
    ...(input.thread.pullRequests ?? [])
      .filter((link) => link.source !== "stack-dismissed")
      .map((link) => link.linkedAt),
    ...input.checkpoints
      .filter((checkpoint) => checkpoint.files.length > 0)
      .map((checkpoint) => DateTime.formatIso(checkpoint.capturedAt)),
  ];
}

export function priceProviderTurns(
  turns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "startedAt" | "completedAt" | "tokenUsage" | "turnTokenUsage">
  >,
  rate: SpendRate,
): ReadonlyArray<SpendEntry> {
  const priced: Array<SpendEntry> = [];
  for (const turn of turns) {
    const usage = turn.turnTokenUsage ?? turn.tokenUsage;
    if (usage === undefined) continue;
    if (usage.inputTokens === undefined && usage.outputTokens === undefined) continue;
    const input = usage.inputTokens ?? 0;
    const cached = Math.min(usage.cachedInputTokens ?? 0, input);
    const other = turn.turnTokenUsage?.otherUsage;
    const usd =
      (input - cached) * rate.inputCostPerToken +
      cached * rate.cacheReadCostPerToken +
      (usage.outputTokens ?? 0) * rate.outputCostPerToken +
      (other?.inputTokens ?? 0) * rate.inputCostPerToken +
      (other?.outputTokens ?? 0) * rate.outputCostPerToken;
    const at = turn.startedAt ?? turn.completedAt;
    const createdAt = at === null ? (turn.tokenUsage?.updatedAt ?? null) : DateTime.formatIso(at);
    if (usd > 0 && createdAt !== null) priced.push({ createdAt, usd });
  }
  return priced;
}

export function spendGuardNoticeId(
  threadId: string,
  kind: SpendGuardMarkerKind,
  reason: SpendGuardStopReason,
  unique: string,
): string {
  return `${SPEND_GUARD_NOTICE_PREFIX}:${kind}:${reason}:${threadId}:${unique}`;
}

export function spendGuardMarkers(
  turnItems: ReadonlyArray<Pick<OrchestrationV2TurnItem, "id" | "type" | "startedAt">>,
): ReadonlyArray<SpendGuardMarker> {
  return turnItems.flatMap((item) => {
    if (item.type !== "system_notice" || item.startedAt === null) return [];
    const [prefix, kind, reason] = item.id.split(":");
    if (prefix !== SPEND_GUARD_NOTICE_PREFIX) return [];
    if (kind !== SPEND_GUARD_FLAGGED_KIND && kind !== SPEND_GUARD_STOPPED_KIND) return [];
    if (reason !== "idle" && reason !== "ceiling") return [];
    return [{ kind, reason, createdAt: DateTime.formatIso(item.startedAt) }];
  });
}

function latest(values: ReadonlyArray<string>): string | null {
  return values.reduce<string | null>(
    (current, value) => (current === null || value > current ? value : current),
    null,
  );
}

export function evaluateSpendGuard(input: SpendGuardInput): SpendGuardEvaluation {
  const idleSince = latest(input.workSignalAts);
  const afterIdle = (createdAt: string) => idleSince === null || createdAt > idleSince;
  const sessionUsd = input.spend.reduce((sum, entry) => sum + entry.usd, 0);
  const idleUsd = input.spend
    .filter((entry) => afterIdle(entry.createdAt))
    .reduce((sum, entry) => sum + entry.usd, 0);
  const flaggedSinceIdle = input.markers.some(
    (marker) => marker.kind === SPEND_GUARD_FLAGGED_KIND && afterIdle(marker.createdAt),
  );
  const stoppedSinceIdle = input.markers.some(
    (marker) =>
      marker.kind === SPEND_GUARD_STOPPED_KIND &&
      marker.reason === "idle" &&
      afterIdle(marker.createdAt),
  );
  const stoppedForCeiling = input.markers.some(
    (marker) => marker.kind === SPEND_GUARD_STOPPED_KIND && marker.reason === "ceiling",
  );
  const { mode, idleFlagUsd, idleStopUsd, sessionCeilingUsd } = input.settings;
  const base = {
    sessionUsd,
    idleUsd,
    idleSince,
    flaggedSinceIdle,
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
    return { ...base, level: "flag", stopReason: null };
  }
  return { ...base, level: "ok", stopReason: null };
}

export function evaluateThreadSpend(
  input: {
    readonly thread: Pick<OrchestrationV2AppThread, "pullRequests" | "modelSelection">;
    readonly providerTurns: ReadonlyArray<
      Pick<
        OrchestrationV2ProviderTurn,
        "startedAt" | "completedAt" | "tokenUsage" | "turnTokenUsage"
      >
    >;
    readonly checkpoints: ReadonlyArray<Pick<OrchestrationV2Checkpoint, "capturedAt" | "files">>;
    readonly turnItems: ReadonlyArray<Pick<OrchestrationV2TurnItem, "id" | "type" | "startedAt">>;
  },
  settings: Pick<ServerSettings, "sessionSpendGuard" | "usagePriceOverrides">,
): SpendGuardEvaluation {
  return evaluateSpendGuard({
    spend: priceProviderTurns(
      input.providerTurns,
      rateForModel(
        input.thread.modelSelection.model,
        settings.usagePriceOverrides,
        settings.sessionSpendGuard.fallbackRate,
      ),
    ),
    markers: spendGuardMarkers(input.turnItems),
    workSignalAts: workSignalAts(input),
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

export interface LaunchCheckInput {
  readonly title: string;
  readonly titlePending: boolean;
  readonly hasOtherUserMessages: boolean;
  readonly creationSource: OrchestrationV2ConversationMessage["creationSource"];
  readonly mode: SessionSpendGuardSettings["mode"];
}

const INTERACTIVE_SOURCES: ReadonlySet<OrchestrationV2ConversationMessage["creationSource"]> =
  new Set(["web", "mobile"]);

export function checkLaunch(input: LaunchCheckInput): "untitled" | null {
  if (input.mode !== "enforce" || INTERACTIVE_SOURCES.has(input.creationSource)) return null;
  const untitled = input.title.trim() === "" || input.title.trim() === "New thread";
  if (untitled && !input.titlePending && input.hasOtherUserMessages) return "untitled";
  return null;
}

export const UNTITLED_LAUNCH_REFUSAL =
  "Automated turns are refused on a thread that still has the default title after its first turn. Give the thread a title, then send again.";
