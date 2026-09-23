/**
 * Usage attribution projection.
 *
 * Re-projects the measured usage the scan already produced onto four reporting
 * levels — prompt, provider request, native session, pull request — using only
 * explicit bindings and links that already exist:
 *
 * - native session → T3 thread: the `resume_cursor_json` identity a provider
 *   adapter wrote, or the `importedTranscripts` metadata an imported session
 *   recorded. See `ProviderSessionRuntimeRepository`.
 * - T3 thread → pull request: `projection_thread_pull_requests`, canonicalized
 *   with `@t3tools/shared/threadPullRequests`.
 *
 * This module is pure: it never reads the clock, the filesystem, or the
 * database, and it never sees a prompt, a response, or a tool payload. Callers
 * feed it allowlisted metadata plus already-normalized measurements. It is a
 * proof of what the existing sources can establish, not a storage or transport
 * decision.
 *
 * Two rules dominate the shape of the output:
 *
 * 1. Granularity is asserted per source, never inferred. A source that emits
 *    one aggregate per turn cannot yield request or prompt counts, so those
 *    levels report `unsupported` instead of a fabricated number.
 * 2. Association is not attribution. A session linked to several pull requests
 *    contributes to each of those PRs' `shared` pool — which is explicitly not
 *    additive — rather than its total being cloned onto every linked PR.
 *
 * @module usageAttribution
 */
import type {
  ThreadPullRequestLinkSource,
  UsageProviderKind,
  UsageTokenTotals,
} from "@t3tools/contracts";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeyOf,
} from "@t3tools/shared/threadPullRequests";

import { EMPTY_TOTALS, addTotals, totalTokens as countTokens } from "./usageTranscripts.ts";

export const USAGE_ATTRIBUTION_VERSION = 1 as const;

/** The four reporting levels this projection can speak to. */
export type AttributionGranularity = "prompt" | "request" | "session" | "pullRequest";

/**
 * How much of a level's measurement is actually established.
 *
 * - `measured` — every contributing record carried the identity this level needs.
 * - `partial` — some records lacked it; totals are a lower bound, not a complete one.
 * - `missing` — the source supports this level but no usable measurement exists.
 *   This is the absence case, and it is never a zero.
 * - `invalid` — an identity was present but malformed for its provider.
 * - `unsupported` — the source cannot establish this level at all.
 */
export type AttributionQuality = "measured" | "partial" | "missing" | "invalid" | "unsupported";

/** Whether a source can establish a level from its native records. */
export type AttributionLevelSupport = "supported" | "unsupported";

/**
 * What each source can and cannot establish, stated once so a caller cannot
 * accidentally treat an unsupported level as a measured zero.
 *
 * `liveQualified` is deliberately `false` for every source: this matrix is
 * derived from source, not from an installed-live capture.
 */
export interface AttributionSourceCapability {
  readonly provider: UsageProviderKind;
  readonly nativeSource: "transcript" | "none";
  readonly session: AttributionLevelSupport;
  readonly prompt: AttributionLevelSupport;
  readonly request: AttributionLevelSupport;
  readonly liveQualified: boolean;
  readonly note: string;
}

export const ATTRIBUTION_SOURCE_CAPABILITIES: readonly AttributionSourceCapability[] = [
  {
    provider: "claude",
    nativeSource: "transcript",
    session: "supported",
    prompt: "unsupported",
    request: "supported",
    liveQualified: false,
    note: "One assistant message is one provider request (message id + request id). A user prompt can span several requests through tool continuation, and no prompt id is written, so prompt totals are not derivable.",
  },
  {
    provider: "codex",
    nativeSource: "transcript",
    session: "supported",
    prompt: "unsupported",
    request: "unsupported",
    liveQualified: false,
    note: "token_count deltas are turn-level increments with no request or prompt id. Request counts must never be inferred by dividing a turn.",
  },
  {
    provider: "grok",
    nativeSource: "transcript",
    session: "supported",
    prompt: "supported",
    request: "unsupported",
    liveQualified: false,
    note: "turn_completed carries prompt_id and may split one prompt across several models. No provider request id is written.",
  },
];

function capabilityOf(provider: UsageProviderKind): AttributionSourceCapability {
  const found = ATTRIBUTION_SOURCE_CAPABILITIES.find((entry) => entry.provider === provider);
  // Unknown providers have no transcript parser, so every level is unsupported.
  return (
    found ?? {
      provider,
      nativeSource: "none",
      session: "unsupported",
      prompt: "unsupported",
      request: "unsupported",
      liveQualified: false,
      note: "No transcript source is scanned for this provider.",
    }
  );
}

/**
 * One already-normalized usage record, tagged with the source that produced it.
 * `costUsd` is the priced cost supplied by the existing pricing path; the
 * projection never prices anything itself.
 */
export interface AttributionUsageRecord {
  readonly provider: UsageProviderKind;
  /** Native session id; `""` when the source record carried none. */
  readonly sessionId: string;
  readonly model: string;
  readonly timestampMs: number;
  readonly totals: UsageTokenTotals;
  readonly costUsd: number;
  readonly dedupeKey: string | null;
  readonly providerRequestId?: string | null;
  readonly providerMessageId?: string | null;
  readonly promptId?: string | null;
  /** Physical source identity, so a duplicate scan can be detected. */
  readonly sourceFingerprint: string;
}

/**
 * An explicit native-session → T3-thread binding that already exists in
 * persisted state. `provider` is normalized to the usage provider kind, so a
 * `claudeAgent` driver is `claude`.
 */
export interface AttributionThreadBinding {
  readonly threadId: string;
  readonly provider: UsageProviderKind;
  readonly providerInstanceId: string | null;
  readonly nativeSessionId: string;
  /**
   * Where the binding came from. `runtimeCursor` is the single current cursor
   * on `provider_session_runtime`; `importedTranscript` is the accumulated
   * imported-file metadata. Nothing else preserves a historical native id.
   */
  readonly origin: "runtimeCursor" | "importedTranscript";
}

/** An existing thread → pull-request link, already canonicalized by the caller. */
export interface AttributionPullRequestLink {
  readonly threadId: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly source: ThreadPullRequestLinkSource;
  readonly linkedAt: string;
}

/** A declared source, used for coverage and duplicate-scan reporting. */
export interface AttributionSource {
  readonly fingerprint: string;
  readonly provider: UsageProviderKind;
  readonly status: "ok" | "missing" | "partial" | "failed";
  readonly distinctSessions: number;
}

export interface UsageAttributionInput {
  readonly generatedAtMs: number;
  readonly records: readonly AttributionUsageRecord[];
  readonly bindings: readonly AttributionThreadBinding[];
  readonly links: readonly AttributionPullRequestLink[];
  readonly sources: readonly AttributionSource[];
}

export interface AttributionTotals {
  readonly tokens: UsageTokenTotals;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly records: number;
}

export type AttributionAllocation =
  | "attributed"
  | "shared"
  | "unallocated"
  | "ambiguous"
  | "missing";

export interface AttributionSessionReport {
  readonly provider: UsageProviderKind;
  readonly sessionId: string;
  readonly models: readonly string[];
  /** `null` when the session is known but no usage was measured for it. */
  readonly totals: AttributionTotals | null;
  readonly quality: AttributionQuality;
  readonly promptQuality: AttributionQuality;
  readonly requestQuality: AttributionQuality;
  /** `null` when the source cannot establish this level. */
  readonly promptCount: number | null;
  readonly requestCount: number | null;
  readonly boundThreadIds: readonly string[];
  readonly providerInstanceIds: readonly string[];
  readonly bindingOrigins: readonly AttributionThreadBinding["origin"][];
  readonly allocation: AttributionAllocation;
  /** Canonical PR keys this session is associated with, if any. */
  readonly pullRequestKeys: readonly string[];
  /** PRs reached only through a stack-sibling link; association, not attribution. */
  readonly stackOnlyPullRequestKeys: readonly string[];
}

export interface AttributionPromptReport {
  readonly provider: UsageProviderKind;
  readonly sessionId: string;
  readonly promptId: string;
  readonly totals: AttributionTotals;
  readonly models: readonly string[];
  readonly boundThreadIds: readonly string[];
  readonly allocation: AttributionAllocation;
}

export interface AttributionRequestReport {
  readonly provider: UsageProviderKind;
  readonly sessionId: string;
  readonly providerRequestId: string;
  readonly providerMessageId: string | null;
  readonly totals: AttributionTotals;
  readonly model: string;
  readonly boundThreadIds: readonly string[];
  readonly allocation: AttributionAllocation;
}

export interface AttributionPullRequestReport {
  readonly key: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly threadIds: readonly string[];
  readonly linkSources: readonly ThreadPullRequestLinkSource[];
  /** Additive: sessions bound to exactly one strong link to this PR. */
  readonly attributed: AttributionTotals;
  /** Sessions also linked to another PR. Never add this into `attributed`. */
  readonly shared: AttributionTotals;
  /** Sessions reaching this PR only through a stack-sibling link. */
  readonly stackAssociationSessions: readonly string[];
  readonly contributingSessions: readonly string[];
}

export interface AttributionCoverage {
  readonly provider: UsageProviderKind;
  readonly nativeSource: AttributionSourceCapability["nativeSource"];
  readonly liveQualified: boolean;
  readonly session: AttributionLevelSupport;
  readonly prompt: AttributionLevelSupport;
  readonly request: AttributionLevelSupport;
  readonly measuredSessions: number;
  readonly missingSessions: number;
  readonly invalidSessions: number;
  readonly unboundSessions: number;
  readonly ambiguousSessions: number;
  readonly recordsWithoutSessionId: number;
}

export interface UsageAttribution {
  readonly contractVersion: typeof USAGE_ATTRIBUTION_VERSION;
  readonly generatedAtMs: number;
  readonly sessions: readonly AttributionSessionReport[];
  readonly prompts: readonly AttributionPromptReport[];
  readonly requests: readonly AttributionRequestReport[];
  readonly pullRequests: readonly AttributionPullRequestReport[];
  /** Usage on sessions linked to more than one strong PR. Not additive. */
  readonly shared: AttributionTotals;
  /** Usage on sessions with no usable PR link, including missing identity. */
  readonly unallocated: AttributionTotals;
  readonly coverage: readonly AttributionCoverage[];
  readonly limitations: readonly string[];
}

const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** `stack-dismissed` is a tombstone; it mirrors `visibleThreadPullRequests`. */
function isVisibleLink(link: AttributionPullRequestLink): boolean {
  return link.source !== "stack-dismissed";
}

/** A strong link asserts real work; a `stack` link is display association only. */
function isStrongLink(link: AttributionPullRequestLink): boolean {
  return link.source !== "stack" && isVisibleLink(link);
}

interface SessionAccumulator {
  provider: UsageProviderKind;
  sessionId: string;
  records: AttributionUsageRecord[];
  requestIds: Set<string>;
  recordsWithRequestId: number;
  promptIds: Set<string>;
  recordsWithPromptId: number;
}

function addTotalsOf(left: AttributionTotals, right: AttributionTotals): AttributionTotals {
  return {
    tokens: addTotals(left.tokens, right.tokens),
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd: left.costUsd + right.costUsd,
    records: left.records + right.records,
  };
}

const ZERO_TOTALS: AttributionTotals = {
  tokens: EMPTY_TOTALS,
  totalTokens: 0,
  costUsd: 0,
  records: 0,
};

function totalsOfRecords(records: readonly AttributionUsageRecord[]): AttributionTotals {
  let tokens = EMPTY_TOTALS;
  let costUsd = 0;
  for (const record of records) {
    tokens = addTotals(tokens, record.totals);
    costUsd += record.costUsd;
  }
  return { tokens, totalTokens: countTokens(tokens), costUsd, records: records.length };
}

/**
 * Identity used for de-duplication when a record carries no `dedupeKey`.
 *
 * Two environments scanning the same directory produce byte-identical codex
 * records (which have no parser dedupe key), so a content signature stops that
 * shared source from being counted twice. It is intentionally not exposed as a
 * provider request id.
 */
function recordContentSignature(record: AttributionUsageRecord): string {
  return [
    record.provider,
    record.sessionId,
    record.model,
    record.timestampMs,
    record.totals.uncachedInputTokens,
    record.totals.cachedInputTokens,
    record.totals.cacheCreationTokens,
    record.totals.outputTokens,
    record.totals.reasoningTokens,
    record.providerRequestId ?? "",
    record.providerMessageId ?? "",
    record.promptId ?? "",
  ].join("\u0000");
}

interface StrongLink {
  readonly key: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly sources: Set<ThreadPullRequestLinkSource>;
  readonly threadIds: Set<string>;
}

interface MutableCoverage {
  provider: UsageProviderKind;
  nativeSource: AttributionSourceCapability["nativeSource"];
  liveQualified: boolean;
  session: AttributionLevelSupport;
  prompt: AttributionLevelSupport;
  request: AttributionLevelSupport;
  measuredSessions: number;
  missingSessions: number;
  invalidSessions: number;
  unboundSessions: number;
  ambiguousSessions: number;
  recordsWithoutSessionId: number;
}

/**
 * Builds the four-level projection from already-measured usage.
 *
 * `generatedAtMs` is supplied rather than read so the projection stays pure and
 * fixtures stay deterministic.
 */
export function buildUsageAttribution(input: UsageAttributionInput): UsageAttribution {
  // 1. De-duplicate records: by declared key when present (fork copies and
  //    resumed history share it), otherwise by content signature.
  const seen = new Set<string>();
  const records: AttributionUsageRecord[] = [];
  for (const record of input.records) {
    const identity = record.dedupeKey ?? recordContentSignature(record);
    if (seen.has(identity)) continue;
    seen.add(identity);
    records.push(record);
  }

  // 2. Bind native sessions to threads, keeping every origin that points at
  //    the same session so a resume that reused one thread is not read as a
  //    second owner.
  const sessionThreads = new Map<
    string,
    {
      threadIds: Set<string>;
      instanceIds: Set<string>;
      origins: Set<AttributionThreadBinding["origin"]>;
    }
  >();
  for (const binding of input.bindings) {
    if (binding.nativeSessionId.length === 0) continue;
    const key = sessionKey(binding.provider, binding.nativeSessionId);
    const entry = sessionThreads.get(key) ?? {
      threadIds: new Set<string>(),
      instanceIds: new Set<string>(),
      origins: new Set<AttributionThreadBinding["origin"]>(),
    };
    entry.threadIds.add(binding.threadId);
    if (binding.providerInstanceId !== null) entry.instanceIds.add(binding.providerInstanceId);
    entry.origins.add(binding.origin);
    sessionThreads.set(key, entry);
  }

  // 3. Index visible PR links per thread and canonical PR metadata.
  const threadStrongPrs = new Map<string, Set<string>>();
  const threadStackPrs = new Map<string, Set<string>>();
  const pullRequestMeta = new Map<string, StrongLink & { threadIds: Set<string> }>();
  for (const link of input.links) {
    if (!isVisibleLink(link)) continue;
    const normalized = normalizeThreadPullRequestKey(link);
    const key = threadPullRequestKeyOf(link);
    const meta = pullRequestMeta.get(key) ?? {
      key,
      host: normalized.host,
      repository: normalized.repository,
      number: normalized.number,
      sources: new Set<ThreadPullRequestLinkSource>(),
      threadIds: new Set<string>(),
    };
    meta.sources.add(link.source);
    meta.threadIds.add(link.threadId);
    pullRequestMeta.set(key, meta as StrongLink & { threadIds: Set<string> });
    const target = isStrongLink(link) ? threadStrongPrs : threadStackPrs;
    const set = target.get(link.threadId) ?? new Set<string>();
    set.add(key);
    target.set(link.threadId, set);
  }

  // 4. Accumulate per native session from measured records, then include
  //    bindings that have no records so "known but unmeasured" is not zero.
  const sessionsByKey = new Map<string, SessionAccumulator>();
  const recordsWithoutSessionIdByProvider = new Map<UsageProviderKind, number>();
  for (const record of records) {
    if (record.sessionId.length === 0) {
      recordsWithoutSessionIdByProvider.set(
        record.provider,
        (recordsWithoutSessionIdByProvider.get(record.provider) ?? 0) + 1,
      );
      continue;
    }
    const key = sessionKey(record.provider, record.sessionId);
    const accumulator = sessionsByKey.get(key) ?? {
      provider: record.provider,
      sessionId: record.sessionId,
      records: [],
      requestIds: new Set<string>(),
      recordsWithRequestId: 0,
      promptIds: new Set<string>(),
      recordsWithPromptId: 0,
    };
    accumulator.records.push(record);
    if (record.providerRequestId) {
      accumulator.requestIds.add(record.providerRequestId);
      accumulator.recordsWithRequestId += 1;
    }
    if (record.promptId) {
      accumulator.promptIds.add(record.promptId);
      accumulator.recordsWithPromptId += 1;
    }
    sessionsByKey.set(key, accumulator);
  }

  const sessionReports: AttributionSessionReport[] = [];
  const promptReports: AttributionPromptReport[] = [];
  const requestReports: AttributionRequestReport[] = [];
  const prAttributed = new Map<string, AttributionTotals>();
  const prShared = new Map<string, AttributionTotals>();
  const prStackAssociations = new Map<string, Set<string>>();
  const prContributing = new Map<string, Set<string>>();
  let shared = ZERO_TOTALS;
  let unallocated = ZERO_TOTALS;
  const coverageByProvider = new Map<UsageProviderKind, MutableCoverage>();

  const sessionUniverse = new Map(sessionsByKey);
  for (const key of sessionThreads.keys()) {
    if (sessionUniverse.has(key)) continue;
    // A bound session with no records is a missing measurement, not a zero.
    sessionUniverse.set(key, {
      provider: providerOfKey(key),
      sessionId: sessionIdOfKey(key),
      records: [],
      requestIds: new Set<string>(),
      recordsWithRequestId: 0,
      promptIds: new Set<string>(),
      recordsWithPromptId: 0,
    });
  }

  for (const [key, accumulator] of sessionUniverse) {
    const { provider, sessionId } = accumulator;
    const capability = capabilityOf(provider);
    const binding = sessionThreads.get(key);
    const boundThreadIds = binding ? [...binding.threadIds].toSorted() : [];
    const instanceIds = binding ? [...binding.instanceIds].toSorted() : [];
    const origins = binding ? [...binding.origins].toSorted() : [];
    const totals = accumulator.records.length === 0 ? null : totalsOfRecords(accumulator.records);
    const models = [...new Set(accumulator.records.map((record) => record.model))].toSorted();

    const sessionQuality: AttributionQuality =
      sessionId.length === 0
        ? "missing"
        : provider === "claude" && !CLAUDE_SESSION_ID_PATTERN.test(sessionId)
          ? "invalid"
          : totals === null
            ? "missing"
            : "measured";

    const promptQuality: AttributionQuality =
      capability.prompt === "unsupported"
        ? "unsupported"
        : accumulator.records.length === 0
          ? "missing"
          : accumulator.recordsWithPromptId === accumulator.records.length
            ? "measured"
            : accumulator.recordsWithPromptId === 0
              ? "missing"
              : "partial";

    const requestQuality: AttributionQuality =
      capability.request === "unsupported"
        ? "unsupported"
        : accumulator.records.length === 0
          ? "missing"
          : accumulator.recordsWithRequestId === accumulator.records.length
            ? "measured"
            : accumulator.recordsWithRequestId === 0
              ? "missing"
              : "partial";

    const strongPrs = new Set<string>();
    for (const threadId of boundThreadIds) {
      for (const prKey of threadStrongPrs.get(threadId) ?? []) strongPrs.add(prKey);
    }
    const stackPrs = new Set<string>();
    for (const threadId of boundThreadIds) {
      for (const prKey of threadStackPrs.get(threadId) ?? []) {
        if (!strongPrs.has(prKey)) stackPrs.add(prKey);
      }
    }

    let allocation: AttributionAllocation;
    if (sessionQuality === "missing" && totals === null) allocation = "missing";
    else if (boundThreadIds.length === 0) allocation = "unallocated";
    else if (boundThreadIds.length > 1) allocation = "ambiguous";
    else if (strongPrs.size === 1) allocation = "attributed";
    else if (strongPrs.size > 1) allocation = "shared";
    else allocation = "unallocated";

    if (totals !== null) {
      if (allocation === "shared") shared = addTotalsOf(shared, totals);
      // Ambiguous sessions are pooled with unallocated usage: neither can be
      // placed on a specific pull request without inventing an owner.
      if (allocation === "unallocated" || allocation === "ambiguous") {
        unallocated = addTotalsOf(unallocated, totals);
      }
      if (allocation === "attributed") {
        for (const prKey of strongPrs) {
          prAttributed.set(prKey, addTotalsOf(prAttributed.get(prKey) ?? ZERO_TOTALS, totals));
        }
      }
      if (allocation === "shared") {
        for (const prKey of strongPrs) {
          prShared.set(prKey, addTotalsOf(prShared.get(prKey) ?? ZERO_TOTALS, totals));
        }
      }
    }
    for (const prKey of strongPrs) {
      const contributing = prContributing.get(prKey) ?? new Set<string>();
      contributing.add(sessionLabel(provider, sessionId));
      prContributing.set(prKey, contributing);
    }
    for (const prKey of stackPrs) {
      const associated = prStackAssociations.get(prKey) ?? new Set<string>();
      associated.add(sessionLabel(provider, sessionId));
      prStackAssociations.set(prKey, associated);
    }

    sessionReports.push({
      provider,
      sessionId,
      models,
      totals,
      quality: sessionQuality,
      promptQuality,
      requestQuality,
      promptCount:
        capability.prompt === "supported" &&
        (promptQuality === "measured" || promptQuality === "partial")
          ? accumulator.promptIds.size
          : null,
      requestCount:
        capability.request === "supported" &&
        (requestQuality === "measured" || requestQuality === "partial")
          ? accumulator.requestIds.size
          : null,
      boundThreadIds,
      providerInstanceIds: instanceIds,
      bindingOrigins: origins,
      allocation,
      pullRequestKeys: [...strongPrs].toSorted(),
      stackOnlyPullRequestKeys: [...stackPrs].toSorted(),
    });

    // 5. Level reports. Only providers whose capability supports the level
    //    produce rows; an unsupported source yields no rows and no counts.
    if (capability.request === "supported" && totals !== null) {
      requestReports.push(...requestRows(accumulator, boundThreadIds, allocation, capability));
    }
    if (capability.prompt === "supported" && totals !== null) {
      promptReports.push(...promptRows(accumulator, boundThreadIds, allocation));
    }

    // 6. Coverage.
    const coverage = coverageByProvider.get(provider) ?? {
      provider,
      nativeSource: capability.nativeSource,
      liveQualified: capability.liveQualified,
      session: capability.session,
      prompt: capability.prompt,
      request: capability.request,
      measuredSessions: 0,
      missingSessions: 0,
      invalidSessions: 0,
      unboundSessions: 0,
      ambiguousSessions: 0,
      recordsWithoutSessionId: recordsWithoutSessionIdByProvider.get(provider) ?? 0,
    };
    if (sessionQuality === "measured") coverage.measuredSessions += 1;
    if (sessionQuality === "missing") coverage.missingSessions += 1;
    if (sessionQuality === "invalid") coverage.invalidSessions += 1;
    if (boundThreadIds.length === 0) coverage.unboundSessions += 1;
    if (allocation === "ambiguous") coverage.ambiguousSessions += 1;
    coverageByProvider.set(provider, coverage);
  }

  for (const [provider, coverage] of coverageByProvider) {
    coverageByProvider.set(provider, {
      ...coverage,
      recordsWithoutSessionId: recordsWithoutSessionIdByProvider.get(provider) ?? 0,
    });
  }

  sessionReports.sort((left, right) =>
    sessionLabel(left.provider, left.sessionId).localeCompare(
      sessionLabel(right.provider, right.sessionId),
    ),
  );
  promptReports.sort((left, right) =>
    `${sessionLabel(left.provider, left.sessionId)}\u0000${left.promptId}`.localeCompare(
      `${sessionLabel(right.provider, right.sessionId)}\u0000${right.promptId}`,
    ),
  );
  requestReports.sort((left, right) =>
    `${sessionLabel(left.provider, left.sessionId)}\u0000${left.providerRequestId}`.localeCompare(
      `${sessionLabel(right.provider, right.sessionId)}\u0000${right.providerRequestId}`,
    ),
  );

  const pullRequests: AttributionPullRequestReport[] = [...pullRequestMeta.values()]
    .map((meta) => ({
      key: meta.key,
      host: meta.host,
      repository: meta.repository,
      number: meta.number,
      threadIds: [...meta.threadIds].toSorted(),
      linkSources: [...meta.sources].toSorted(),
      attributed: prAttributed.get(meta.key) ?? ZERO_TOTALS,
      shared: prShared.get(meta.key) ?? ZERO_TOTALS,
      stackAssociationSessions: [...(prStackAssociations.get(meta.key) ?? [])].toSorted(),
      contributingSessions: [...(prContributing.get(meta.key) ?? [])].toSorted(),
    }))
    .toSorted((left, right) => left.key.localeCompare(right.key));

  const coverage: AttributionCoverage[] = [...coverageByProvider.values()].toSorted((left, right) =>
    left.provider.localeCompare(right.provider),
  );

  return {
    contractVersion: USAGE_ATTRIBUTION_VERSION,
    generatedAtMs: input.generatedAtMs,
    sessions: sessionReports,
    prompts: promptReports,
    requests: requestReports,
    pullRequests,
    shared,
    unallocated,
    coverage,
    limitations: limitationsFor(input, coverage),
  };
}

function requestRows(
  accumulator: SessionAccumulator,
  boundThreadIds: readonly string[],
  allocation: AttributionAllocation,
  capability: AttributionSourceCapability,
): AttributionRequestReport[] {
  if (capability.request !== "supported") return [];
  const grouped = new Map<string, AttributionUsageRecord[]>();
  for (const record of accumulator.records) {
    if (!record.providerRequestId) continue;
    const rows = grouped.get(record.providerRequestId) ?? [];
    rows.push(record);
    grouped.set(record.providerRequestId, rows);
  }
  return [...grouped.entries()].map(([providerRequestId, rows]) => ({
    provider: accumulator.provider,
    sessionId: accumulator.sessionId,
    providerRequestId,
    providerMessageId: rows.find((row) => !!row.providerMessageId)?.providerMessageId ?? null,
    totals: totalsOfRecords(rows),
    model: rows[0]?.model ?? "",
    boundThreadIds,
    allocation,
  }));
}

function promptRows(
  accumulator: SessionAccumulator,
  boundThreadIds: readonly string[],
  allocation: AttributionAllocation,
): AttributionPromptReport[] {
  const grouped = new Map<string, AttributionUsageRecord[]>();
  for (const record of accumulator.records) {
    if (!record.promptId) continue;
    const rows = grouped.get(record.promptId) ?? [];
    rows.push(record);
    grouped.set(record.promptId, rows);
  }
  return [...grouped.entries()].map(([promptId, rows]) => ({
    provider: accumulator.provider,
    sessionId: accumulator.sessionId,
    promptId,
    totals: totalsOfRecords(rows),
    models: [...new Set(rows.map((row) => row.model))].toSorted(),
    boundThreadIds,
    allocation,
  }));
}

function limitationsFor(
  input: UsageAttributionInput,
  coverage: readonly AttributionCoverage[],
): readonly string[] {
  const limitations: string[] = [
    "A native session maps to a T3 thread only through the current resume cursor or imported-transcript metadata; a session switch, fork, or restart that overwrote the cursor leaves earlier usage unbound.",
    "Provider-instance identity is not recoverable from a transcript scan, so two instances of one provider cannot be told apart at the record level.",
    "Request and prompt counts are reported only where the native source writes those ids; a turn-level source reports `unsupported`, never an inferred count.",
  ];
  const duplicateFingerprints =
    input.sources.length - new Set(input.sources.map((source) => source.fingerprint)).size;
  if (duplicateFingerprints > 0) {
    limitations.push(
      `${duplicateFingerprints} duplicate source fingerprint(s) were reported; identical records are de-duplicated, but a shared source still requires one environment to be dropped upstream.`,
    );
  }
  if (coverage.some((entry) => entry.missingSessions > 0)) {
    limitations.push(
      "Some known sessions have no measured usage. They are reported as `missing` with a null total; this is not a zero-cost success.",
    );
  }
  if (input.bindings.some((binding) => binding.origin === "runtimeCursor")) {
    limitations.push(
      "Only the newest native session id per thread is durable. Additive retention must land before historical re-attribution is possible.",
    );
  }
  return limitations;
}

function sessionKey(provider: UsageProviderKind, sessionId: string): string {
  return `${provider}\u0000${sessionId}`;
}

function providerOfKey(key: string): UsageProviderKind {
  return key.slice(0, key.indexOf("\u0000")) as UsageProviderKind;
}

function sessionIdOfKey(key: string): string {
  return key.slice(key.indexOf("\u0000") + 1);
}

function sessionLabel(provider: UsageProviderKind, sessionId: string): string {
  return `${provider}:${sessionId.length === 0 ? "<none>" : sessionId}`;
}

/**
 * A compact human-readable rendering of the projection. Intended for logs and
 * PR evidence; the JSON form is the machine-readable one.
 */
export function renderUsageAttributionText(projection: UsageAttribution): string {
  const lines: string[] = ["Usage attribution", ""];
  lines.push(`Sessions: ${projection.sessions.length}`);
  for (const session of projection.sessions) {
    const tokens = session.totals === null ? "missing" : `${session.totals.totalTokens} tokens`;
    const cost = session.totals === null ? "" : ` $${session.totals.costUsd.toFixed(4)}`;
    const prompts =
      session.promptCount === null ? "prompts=unsupported" : `prompts=${session.promptCount}`;
    const requests =
      session.requestCount === null ? "requests=unsupported" : `requests=${session.requestCount}`;
    lines.push(
      `  ${sessionLabel(session.provider, session.sessionId)} [${session.quality}/${session.allocation}] ${tokens}${cost} ${prompts} ${requests} threads=${
        session.boundThreadIds.length === 0 ? "<unbound>" : session.boundThreadIds.join(",")
      }`,
    );
  }
  lines.push("", "Pull requests:");
  if (projection.pullRequests.length === 0) lines.push("  <none>");
  for (const pr of projection.pullRequests) {
    lines.push(
      `  ${pr.key} attributed=${pr.attributed.totalTokens} tokens shared=${pr.shared.totalTokens} tokens sessions=${
        pr.contributingSessions.length === 0 ? "<none>" : pr.contributingSessions.join(",")
      } sources=${pr.linkSources.join(",")}`,
    );
  }
  lines.push(
    "",
    `Shared (not additive): ${projection.shared.totalTokens} tokens`,
    `Unallocated: ${projection.unallocated.totalTokens} tokens`,
    "",
    "Coverage:",
  );
  for (const entry of projection.coverage) {
    lines.push(
      `  ${entry.provider} session=${entry.session} prompt=${entry.prompt} request=${entry.request} measured=${entry.measuredSessions} missing=${entry.missingSessions} unbound=${entry.unboundSessions} ambiguous=${entry.ambiguousSessions}`,
    );
  }
  return lines.join("\n");
}
