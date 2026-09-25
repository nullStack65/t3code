/**
 * Usage attribution projection.
 *
 * Re-projects the measured usage the scan already produced onto four reporting
 * levels — prompt, provider request, native session, pull request — using only
 * explicit bindings and links that already exist:
 *
 * - native session → T3 thread: the `resume_cursor_json` identity a provider
 *   adapter wrote, or the `importedTranscripts` metadata an imported session
 *   recorded. See `usageAttributionSources` for the read-only extraction from
 *   the persisted row shapes.
 * - T3 thread → pull request: `projection_thread_pull_requests`, canonicalized
 *   with `@t3tools/shared/threadPullRequests`.
 *
 * This module is pure: it never reads the clock, the filesystem, or the
 * database, and it never sees a prompt, a response, or a tool payload. Callers
 * feed it allowlisted metadata plus already-normalized measurements. It is a
 * proof of what the existing sources can establish, not a storage or transport
 * decision.
 *
 * Three rules dominate the shape of the output:
 *
 * 1. Granularity is asserted per source, never inferred. A source that emits
 *    one aggregate per turn cannot yield request or prompt counts, so those
 *    levels report `unsupported` instead of a fabricated number.
 * 2. Association is not attribution. A session linked to several pull requests
 *    contributes to one global `shared` pool — explicitly not additive — rather
 *    than its total being cloned onto every linked PR.
 * 3. Nothing measured is dropped. Records without a session id land in an
 *    explicit `orphan` bucket, and the reconciliation
 *    `attributed + shared + unallocated + orphan === measured` holds against
 *    the deduplicated input, not against a pre-filtered session list.
 *
 * @module usageAttribution
 */
import type {
  ThreadPullRequestLinkSource,
  UsageCostSource,
  UsageProviderKind,
  UsageTokenTotals,
} from "@t3tools/contracts";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeyOf,
} from "@t3tools/shared/threadPullRequests";

import { EMPTY_TOTALS, addTotals, totalTokens as countTokens } from "./usageTranscripts.ts";
import type {
  DedupeKeyScope,
  UsageMeasurement,
  UsageMeasurementCompleteness,
} from "./usageTranscripts.ts";

export const USAGE_ATTRIBUTION_VERSION = 2 as const;

/** The four reporting levels this projection can speak to. */
export type AttributionGranularity = "prompt" | "request" | "session" | "pullRequest";

/**
 * How much of a level's measurement is actually established.
 *
 * - `measured` — every contributing record carried a real measurement (an
 *   explicit zero counts; an empty container does not).
 * - `partial` — some records lacked the level's identity, or the presence of a
 *   measurement was erased (a legacy cache row). Totals are a lower bound.
 * - `missing` — the source supports this level but no usable measurement exists.
 *   This is the absence case, and it is never a zero.
 * - `invalid` — an identity or usage container was present but malformed.
 * - `unavailable` — the source erased the information before we saw it.
 * - `unsupported` — the source cannot establish this level at all.
 */
export type AttributionQuality =
  | "measured"
  | "partial"
  | "missing"
  | "invalid"
  | "unavailable"
  | "unsupported";

/** Whether a source can establish a level from its native records. */
export type AttributionLevelSupport = "supported" | "unsupported";

/** Whether a native session id is usable, independent of the measurement. */
export type AttributionIdentityQuality = "valid" | "missing" | "invalid" | "unavailable";

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
 *
 * `dedupeKey` is the scan/delivery identity, kept apart from the native
 * observation ids below. For keyless sources (Codex `token_count`) the scan
 * stamps it with the occurrence-aware identity from `usageTranscripts`; a
 * record with no key at all is treated as an unkeyed observation and surfaced
 * as uncertain rather than silently merged with a content-equal neighbour.
 */
export interface AttributionUsageRecord {
  readonly provider: UsageProviderKind;
  /** Native session id; `""` when the source record carried none. */
  readonly sessionId: string;
  readonly model: string;
  readonly timestampMs: number;
  readonly totals: UsageTokenTotals;
  readonly costUsd: number;
  /** Scan/delivery identity, or `null` when the record is unkeyed. */
  readonly dedupeKey: string | null;
  /**
   * How far `dedupeKey` can be trusted on its own. `global` (the default) means
   * the key is a globally qualified native observation id; `source-local` means
   * it must be qualified by the native session. See `usageTranscripts`.
   */
  readonly dedupeKeyScope?: DedupeKeyScope;
  readonly providerRequestId?: string | null;
  readonly providerMessageId?: string | null;
  readonly promptId?: string | null;
  /** Physical source identity, for source coverage and duplicate detection. */
  readonly sourceFingerprint: string;
  /**
   * Whether tokens were actually measured. Absent defaults to `observed` when
   * any total is nonzero and `unavailable` when all are zero, so a legacy row
   * whose presence was erased is never read as a measured zero.
   */
  readonly measurement?: UsageMeasurement;
  /** Whether an `observed` measurement covered every required field. */
  readonly measurementCompleteness?: UsageMeasurementCompleteness;
  /** Present-but-invalid recognised token fields; distinguishes invalid from absent. */
  readonly invalidTokenFields?: number;
  /**
   * `false` when the source erased native identity before we saw it (a legacy
   * cache row). Kept apart from numeric quality so an absent native id is
   * reported `unavailable`, never recovered from token magnitude.
   */
  readonly identityAvailable?: boolean;
  /** Additive increment or replaceable snapshot. Absent means `delta`. */
  readonly scope?: "delta" | "snapshot";
  /** Cost provenance, preserved per record so a view can carry it. */
  readonly costSource?: UsageCostSource;
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
   * imported-file metadata; `sessionHistory` is the append-only
   * `provider_session_history` row that survives a cursor overwrite.
   */
  readonly origin: "runtimeCursor" | "importedTranscript" | "sessionHistory";
}

/** An existing thread → pull-request link, already canonicalized by the caller. */
export interface AttributionPullRequestLink {
  readonly threadId: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly source: ThreadPullRequestLinkSource;
  readonly linkedAt: string;
  /**
   * The stored URL, when the caller has it. `normalizeThreadPullRequestKey`
   * uses it to recover a Forgejo HTTP port that the bare host/repository loses.
   */
  readonly url?: string;
}

/** A declared source, used for coverage and duplicate-scan reporting. */
export interface AttributionSource {
  readonly fingerprint: string;
  readonly provider: UsageProviderKind;
  readonly status: "ok" | "missing" | "partial" | "failed";
  readonly distinctSessions: number;
}

export interface UsageAttributionInput {
  /** Read cutoff. Associations are as of this instant. */
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

/** Per-model contribution, so a mixed-model session is never flattened away. */
export interface AttributionModelContribution {
  readonly model: string;
  readonly totals: UsageTokenTotals;
  readonly totalTokens: number;
  readonly costUsd: number;
  /** `unknown` when the caller supplied no provenance; `mixed` when they differ. */
  readonly costSource: UsageCostSource | "unknown" | "mixed";
  readonly records: number;
}

export type AttributionAllocation =
  | "attributed"
  | "shared"
  | "unallocated"
  | "ambiguous"
  | "missing"
  | "orphan";

export interface AttributionSessionReport {
  readonly provider: UsageProviderKind;
  readonly sessionId: string;
  readonly models: readonly string[];
  readonly modelContributions: readonly AttributionModelContribution[];
  /** `null` when the session is known but no usage was measured for it. */
  readonly totals: AttributionTotals | null;
  /** Session-id validity, independent of measurement. */
  readonly identityQuality: AttributionIdentityQuality;
  /** Numeric completeness, independent of identity and allocation. */
  readonly measurementQuality: AttributionQuality;
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
  /** `uncertain` when any contributing record had no scan/delivery identity. */
  readonly recordIdentity: "exact" | "uncertain";
  /** `conflict` when two versions of one identity disagreed. */
  readonly conflict: boolean;
}

export interface AttributionPromptReport {
  readonly provider: UsageProviderKind;
  readonly sessionId: string;
  readonly promptId: string;
  readonly totals: AttributionTotals;
  readonly models: readonly string[];
  readonly modelContributions: readonly AttributionModelContribution[];
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
  /** Per-model contribution of `attributed`; never additive with `shared`. */
  readonly attributedModelContributions: readonly AttributionModelContribution[];
  /** Sessions reaching this PR only through a stack-sibling link. */
  readonly stackAssociationSessions: readonly string[];
  readonly contributingSessions: readonly string[];
}

export interface AttributionSourceStatusCounts {
  readonly ok: number;
  readonly missing: number;
  readonly partial: number;
  readonly failed: number;
}

export interface AttributionCoverage {
  readonly provider: UsageProviderKind;
  readonly nativeSource: AttributionSourceCapability["nativeSource"];
  readonly liveQualified: boolean;
  readonly session: AttributionLevelSupport;
  readonly prompt: AttributionLevelSupport;
  readonly request: AttributionLevelSupport;
  readonly declaredSources: number;
  readonly distinctSourceFingerprints: number;
  readonly sourceStatus: AttributionSourceStatusCounts;
  readonly measuredSessions: number;
  readonly partialSessions: number;
  readonly missingSessions: number;
  readonly invalidSessions: number;
  readonly unavailableSessions: number;
  readonly unboundSessions: number;
  readonly ambiguousSessions: number;
  /** Records that carried no session id at all. */
  readonly recordsWithoutSessionId: number;
  /** Records whose scan/delivery identity was unknown. */
  readonly unkeyedRecords: number;
  /** Conflicting versions of one observation that were kept-first. */
  readonly conflictingRecords: number;
}

/** How the projection's associations are grounded, so the claim is bounded. */
export interface AttributionAssociationBasis {
  /** Associations are read from links that exist at `cutoffMs`. */
  readonly basis: "links-at-read-time";
  readonly cutoffMs: number;
  /**
   * Always `false`: allocation is recomputed from the links present at read
   * time, so a changed link changes the recomputed view. `linkedAt` does not
   * gate allocation, so pre-link implementation work is included.
   */
  readonly linkedAtGovernsAllocation: false;
}

export interface AttributionIdentityDiagnostics {
  /** Repeated deliveries of one identity that were collapsed. */
  readonly duplicatesDropped: number;
  /** Snapshot observations that replaced an earlier value for the same identity. */
  readonly snapshotsReplaced: number;
  /** Same identity, different content, no snapshot semantics: kept-first. */
  readonly conflicts: number;
  /** Records with no scan/delivery identity; counted, not merged. */
  readonly unkeyedRecords: number;
  /** Records with no session id, preserved in `orphan`. */
  readonly orphanRecords: number;
}

export interface UsageAttribution {
  readonly contractVersion: typeof USAGE_ATTRIBUTION_VERSION;
  readonly generatedAtMs: number;
  readonly association: AttributionAssociationBasis;
  readonly identity: AttributionIdentityDiagnostics;
  readonly sessions: readonly AttributionSessionReport[];
  readonly prompts: readonly AttributionPromptReport[];
  readonly requests: readonly AttributionRequestReport[];
  readonly pullRequests: readonly AttributionPullRequestReport[];
  /** Usage on sessions linked to more than one strong PR. Not additive. */
  readonly shared: AttributionTotals;
  /** Usage on sessions with no usable PR link, including missing identity. */
  readonly unallocated: AttributionTotals;
  /** Usage on records with no native session id. Additive with the above. */
  readonly orphan: AttributionTotals;
  /** Deduplicated input total. `attributed + shared + unallocated + orphan`. */
  readonly measured: AttributionTotals;
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

function anyTotal(record: AttributionUsageRecord): number {
  return countTokens(record.totals);
}

/** Presence of a measurement, with the legacy-erased case made explicit. */
function effectiveMeasurement(record: AttributionUsageRecord): UsageMeasurement {
  if (record.measurement !== undefined) return record.measurement;
  return anyTotal(record) > 0 ? "observed" : "unavailable";
}

/**
 * The identity a record is de-duplicated under.
 *
 * A `global` key is namespaced by provider only; a `source-local` key is
 * qualified by the canonical native session, never by a physical path, so a
 * copy of the same session at another location still collapses while two
 * sessions that happen to reuse a local key stay distinct.
 */
function dedupeIdentity(record: AttributionUsageRecord): string {
  return (record.dedupeKeyScope ?? "global") === "source-local"
    ? `${record.provider}\u0000local\u0000${record.sessionId}\u0000${record.dedupeKey}`
    : `${record.provider}\u0000${record.dedupeKey}`;
}

/** Per-record numeric quality, keeping completeness and validity separate. */
type RecordQuality = "measured" | "partial" | "empty" | "invalid" | "unavailable";

function recordQuality(record: AttributionUsageRecord): RecordQuality {
  const measurement = record.measurement;
  if (measurement === undefined) {
    // No declared measurement: a nonzero total proves some tokens were
    // measured, but never that the measurement was complete.
    return anyTotal(record) > 0 ? "partial" : "unavailable";
  }
  if (measurement === "observed") {
    return record.measurementCompleteness === "partial" ? "partial" : "measured";
  }
  return measurement;
}

/**
 * Content of a measured observation, used to tell a repeated delivery from a
 * conflicting version of the same identity. Deliberately excludes
 * `sourceFingerprint`: a copy at another path is the same observation. Cost and
 * its provenance are included, so a record whose cost changed is a conflicting
 * version of one observation rather than a silent duplicate.
 */
function observationContent(record: AttributionUsageRecord): string {
  return [
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
    record.costUsd,
    record.costSource ?? "",
    effectiveMeasurement(record),
  ].join("\u0000");
}

function modelContributions(
  records: readonly AttributionUsageRecord[],
): readonly AttributionModelContribution[] {
  const byModel = new Map<
    string,
    { totals: UsageTokenTotals; costUsd: number; records: number; sources: Set<string> }
  >();
  for (const record of records) {
    const entry = byModel.get(record.model) ?? {
      totals: EMPTY_TOTALS,
      costUsd: 0,
      records: 0,
      sources: new Set<string>(),
    };
    entry.totals = addTotals(entry.totals, record.totals);
    entry.costUsd += record.costUsd;
    entry.records += 1;
    entry.sources.add(record.costSource ?? "unknown");
    byModel.set(record.model, entry);
  }
  return [...byModel.entries()]
    .map(([model, entry]): AttributionModelContribution => {
      const sources = [...entry.sources].toSorted();
      const costSource =
        sources.length === 1 ? (sources[0] as UsageCostSource | "unknown") : "mixed";
      return {
        model,
        totals: entry.totals,
        totalTokens: countTokens(entry.totals),
        costUsd: entry.costUsd,
        costSource,
        records: entry.records,
      };
    })
    .toSorted((left, right) => left.model.localeCompare(right.model));
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
  declaredSources: number;
  fingerprints: Set<string>;
  sourceStatus: { ok: number; missing: number; partial: number; failed: number };
  measuredSessions: number;
  partialSessions: number;
  missingSessions: number;
  invalidSessions: number;
  unavailableSessions: number;
  unboundSessions: number;
  ambiguousSessions: number;
  recordsWithoutSessionId: number;
  unkeyedRecords: number;
  conflictingRecords: number;
}

/**
 * Builds the four-level projection from already-measured usage.
 *
 * `generatedAtMs` is supplied rather than read so the projection stays pure and
 * fixtures stay deterministic. It is also the association cutoff.
 */
export function buildUsageAttribution(input: UsageAttributionInput): UsageAttribution {
  // 1. Identity and de-duplication.
  //
  //    A declared key is the scan/delivery identity. Its scope is explicit: a
  //    `global` key is a globally qualified native observation id and is
  //    namespaced by provider alone; a `source-local` key is qualified by the
  //    native session, because the same local key in two sessions is two
  //    observations, not one. A repeated delivery (same identity, same content)
  //    is dropped; a snapshot replaces the earlier value; a differing delta for
  //    the same identity is a conflict and is exposed rather than silently
  //    discarded. A record with no key at all is unkeyed: it is kept and
  //    counted, never merged by content equality, and the session is marked
  //    uncertain.
  const kept: AttributionUsageRecord[] = [];
  const keptIndexByIdentity = new Map<string, number>();
  const conflictSessions = new Set<string>();
  let duplicatesDropped = 0;
  let snapshotsReplaced = 0;
  let conflicts = 0;
  let unkeyedRecords = 0;

  for (const record of input.records) {
    if (record.dedupeKey === null || record.dedupeKey.length === 0) {
      unkeyedRecords += 1;
      kept.push(record);
      continue;
    }
    const identity = dedupeIdentity(record);
    const existingIndex = keptIndexByIdentity.get(identity);
    if (existingIndex === undefined) {
      keptIndexByIdentity.set(identity, kept.length);
      kept.push(record);
      continue;
    }
    const existing = kept[existingIndex]!;
    // A global key that shows up under a second native session is incompatible
    // ownership, not a copy: one native observation cannot belong to two
    // sessions. Surface it instead of silently dropping a version. A
    // source-local key cannot reach here across sessions, because the session
    // is part of its identity.
    if (existing.sessionId !== record.sessionId) {
      conflicts += 1;
      conflictSessions.add(sessionKey(existing.provider, existing.sessionId));
      conflictSessions.add(sessionKey(record.provider, record.sessionId));
      continue;
    }
    if (observationContent(existing) === observationContent(record)) {
      duplicatesDropped += 1;
      continue;
    }
    if ((record.scope ?? "delta") === "snapshot") {
      kept[existingIndex] = record;
      snapshotsReplaced += 1;
      continue;
    }
    conflicts += 1;
    conflictSessions.add(sessionKey(record.provider, record.sessionId));
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

  // 4. Accumulate per native session from measured records. A record with no
  //    session id is preserved in the orphan bucket instead of being dropped.
  const sessionsByKey = new Map<string, SessionAccumulator>();
  const orphanRecords: AttributionUsageRecord[] = [];
  const orphanByProvider = new Map<UsageProviderKind, AttributionUsageRecord[]>();
  for (const record of kept) {
    if (record.sessionId.length === 0) {
      orphanRecords.push(record);
      const list = orphanByProvider.get(record.provider) ?? [];
      list.push(record);
      orphanByProvider.set(record.provider, list);
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
  const prAttributedRecords = new Map<string, AttributionUsageRecord[]>();
  const prStackAssociations = new Map<string, Set<string>>();
  const prContributing = new Map<string, Set<string>>();
  let shared = ZERO_TOTALS;
  let unallocated = ZERO_TOTALS;
  const coverageByProvider = new Map<UsageProviderKind, MutableCoverage>();

  const ensureCoverage = (provider: UsageProviderKind): MutableCoverage => {
    const capability = capabilityOf(provider);
    const existing = coverageByProvider.get(provider);
    if (existing !== undefined) return existing;
    const created: MutableCoverage = {
      provider,
      nativeSource: capability.nativeSource,
      liveQualified: capability.liveQualified,
      session: capability.session,
      prompt: capability.prompt,
      request: capability.request,
      declaredSources: 0,
      fingerprints: new Set<string>(),
      sourceStatus: { ok: 0, missing: 0, partial: 0, failed: 0 },
      measuredSessions: 0,
      partialSessions: 0,
      missingSessions: 0,
      invalidSessions: 0,
      unavailableSessions: 0,
      unboundSessions: 0,
      ambiguousSessions: 0,
      recordsWithoutSessionId: 0,
      unkeyedRecords: 0,
      conflictingRecords: 0,
    };
    coverageByProvider.set(provider, created);
    return created;
  };

  // Coverage is seeded from declared sources first, so a missing or failed
  // source still produces a row and is never read as "nothing to measure".
  for (const source of input.sources) {
    const coverage = ensureCoverage(source.provider);
    coverage.declaredSources += 1;
    coverage.sourceStatus[source.status] += 1;
    if (source.fingerprint.length > 0) coverage.fingerprints.add(source.fingerprint);
  }
  // Fingerprints come from every input record, including a dropped duplicate:
  // a copied history still proves a second physical source exists.
  for (const record of input.records) {
    const coverage = ensureCoverage(record.provider);
    if (record.sourceFingerprint.length > 0) coverage.fingerprints.add(record.sourceFingerprint);
  }
  for (const record of kept) {
    const coverage = ensureCoverage(record.provider);
    if (record.dedupeKey === null || record.dedupeKey.length === 0) coverage.unkeyedRecords += 1;
    if (conflictSessions.has(sessionKey(record.provider, record.sessionId))) {
      coverage.conflictingRecords += 1;
    }
  }
  for (const binding of input.bindings) ensureCoverage(binding.provider);

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

    const identityQuality: AttributionIdentityQuality =
      sessionId.length === 0
        ? "missing"
        : provider === "claude" && !CLAUDE_SESSION_ID_PATTERN.test(sessionId)
          ? "invalid"
          : "valid";

    const qualities = accumulator.records.map(recordQuality);
    const hasValidMeasurement = qualities.some(
      (quality) => quality === "measured" || quality === "partial",
    );
    const measurementQuality: AttributionQuality =
      accumulator.records.length === 0
        ? "missing"
        : qualities.every((quality) => quality === "measured")
          ? "measured"
          : qualities.every((quality) => quality === "unavailable")
            ? "unavailable"
            : hasValidMeasurement
              ? "partial"
              : qualities.some((quality) => quality === "invalid")
                ? "invalid"
                : qualities.every((quality) => quality === "empty")
                  ? "invalid"
                  : "unavailable";

    // A legacy row erased native identity entirely; an absent id there is
    // `unavailable`, never `missing`, and never recovered from a nonzero total.
    const identityErased =
      accumulator.records.length > 0 &&
      accumulator.records.every((record) => record.identityAvailable === false);

    const identityLevelQuality = (
      level: "prompt" | "request",
      recordsWithId: number,
    ): AttributionQuality => {
      if (capability[level] === "unsupported") return "unsupported";
      if (accumulator.records.length === 0) return "missing";
      if (identityErased) return "unavailable";
      if (recordsWithId === 0) return "missing";
      if (recordsWithId < accumulator.records.length) return "partial";
      if (qualities.every((quality) => quality === "measured")) return "measured";
      return "partial";
    };

    const promptQuality = identityLevelQuality("prompt", accumulator.recordsWithPromptId);
    const requestQuality = identityLevelQuality("request", accumulator.recordsWithRequestId);

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
    if (totals === null && measurementQuality === "missing") allocation = "missing";
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
          const records = prAttributedRecords.get(prKey) ?? [];
          records.push(...accumulator.records);
          prAttributedRecords.set(prKey, records);
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
      modelContributions: modelContributions(accumulator.records),
      totals,
      identityQuality,
      measurementQuality,
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
      recordIdentity: accumulator.records.some(
        (record) => record.dedupeKey === null || record.dedupeKey.length === 0,
      )
        ? "uncertain"
        : "exact",
      conflict: conflictSessions.has(key),
    });

    // 5. Level reports. Only providers whose capability supports the level
    //    produce rows; an unsupported source yields no rows and no counts.
    if (capability.request === "supported" && totals !== null) {
      requestReports.push(...requestRows(accumulator, boundThreadIds, allocation, capability));
    }
    if (capability.prompt === "supported" && totals !== null) {
      promptReports.push(...promptRows(accumulator, boundThreadIds, allocation));
    }

    // 6. Coverage counts, per axis.
    const coverage = ensureCoverage(provider);
    if (identityQuality === "valid") {
      if (measurementQuality === "measured") coverage.measuredSessions += 1;
      if (measurementQuality === "partial") coverage.partialSessions += 1;
      if (measurementQuality === "missing") coverage.missingSessions += 1;
      if (measurementQuality === "invalid") coverage.invalidSessions += 1;
      if (measurementQuality === "unavailable") coverage.unavailableSessions += 1;
    } else if (identityQuality === "invalid") {
      coverage.invalidSessions += 1;
    } else {
      coverage.missingSessions += 1;
    }
    if (boundThreadIds.length === 0) coverage.unboundSessions += 1;
    if (allocation === "ambiguous") coverage.ambiguousSessions += 1;
  }

  const orphan = totalsOfRecords(orphanRecords);
  for (const [provider, records] of orphanByProvider) {
    ensureCoverage(provider).recordsWithoutSessionId += records.length;
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
      attributedModelContributions: modelContributions(prAttributedRecords.get(meta.key) ?? []),
      stackAssociationSessions: [...(prStackAssociations.get(meta.key) ?? [])].toSorted(),
      contributingSessions: [...(prContributing.get(meta.key) ?? [])].toSorted(),
    }))
    .toSorted((left, right) => left.key.localeCompare(right.key));

  const coverage: AttributionCoverage[] = [...coverageByProvider.values()]
    .map((entry): AttributionCoverage => ({
      provider: entry.provider,
      nativeSource: entry.nativeSource,
      liveQualified: entry.liveQualified,
      session: entry.session,
      prompt: entry.prompt,
      request: entry.request,
      declaredSources: entry.declaredSources,
      distinctSourceFingerprints: entry.fingerprints.size,
      sourceStatus: { ...entry.sourceStatus },
      measuredSessions: entry.measuredSessions,
      partialSessions: entry.partialSessions,
      missingSessions: entry.missingSessions,
      invalidSessions: entry.invalidSessions,
      unavailableSessions: entry.unavailableSessions,
      unboundSessions: entry.unboundSessions,
      ambiguousSessions: entry.ambiguousSessions,
      recordsWithoutSessionId: entry.recordsWithoutSessionId,
      unkeyedRecords: entry.unkeyedRecords,
      conflictingRecords: entry.conflictingRecords,
    }))
    .toSorted((left, right) => left.provider.localeCompare(right.provider));

  const measured = totalsOfRecords(kept);

  return {
    contractVersion: USAGE_ATTRIBUTION_VERSION,
    generatedAtMs: input.generatedAtMs,
    association: {
      basis: "links-at-read-time",
      cutoffMs: input.generatedAtMs,
      linkedAtGovernsAllocation: false,
    },
    identity: {
      duplicatesDropped,
      snapshotsReplaced,
      conflicts,
      unkeyedRecords,
      orphanRecords: orphanRecords.length,
    },
    sessions: sessionReports,
    prompts: promptReports,
    requests: requestReports,
    pullRequests,
    shared,
    unallocated,
    orphan,
    measured,
    coverage,
    limitations: limitationsFor(input, coverage, {
      unkeyedRecords,
      conflicts,
      orphanRecords: orphanRecords.length,
    }),
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
    modelContributions: modelContributions(rows),
    boundThreadIds,
    allocation,
  }));
}

function limitationsFor(
  input: UsageAttributionInput,
  coverage: readonly AttributionCoverage[],
  identity: { unkeyedRecords: number; conflicts: number; orphanRecords: number },
): readonly string[] {
  const limitations: string[] = [
    "A native session maps to a T3 thread only through the current resume cursor or imported-transcript metadata; a session switch, fork, or restart that overwrote the cursor leaves earlier usage unbound.",
    "Provider-instance identity is not recoverable from a transcript scan, so two instances of one provider cannot be told apart at the record level.",
    "Request and prompt counts are reported only where the native source writes those ids; a turn-level source reports `unsupported`, never an inferred count.",
    "Associations are read from the links that exist at `generatedAtMs`. `linkedAt` does not gate allocation, so a link added after a session ran still associates that session's usage, and a link removed or changed rewrites the recomputed view. Pre-link implementation work is included; historical allocation as of a past instant is unavailable without temporal evidence.",
    "Cost is API-equivalent list value, not subscription spend; subscription coverage is out of scope here.",
  ];
  if (input.records.some((record) => record.costSource === undefined)) {
    limitations.push(
      'Some records carried no cost provenance. Their contribution reports `costSource: "unknown"` rather than being assumed priced or unpriced.',
    );
  }
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
  if (coverage.some((entry) => entry.sourceStatus.missing + entry.sourceStatus.failed > 0)) {
    limitations.push(
      "At least one declared source is missing or failed; its absence is coverage, not a measured zero.",
    );
  }
  if (identity.unkeyedRecords > 0) {
    limitations.push(
      `${identity.unkeyedRecords} record(s) carried no scan/delivery identity. They are counted, not merged by content equality, and the owning session is marked "uncertain"; a repeated delivery of an unkeyed record cannot be told from a second equal occurrence.`,
    );
  }
  if (identity.conflicts > 0) {
    limitations.push(
      `${identity.conflicts} identity conflict(s) were found: the same identity appeared with different content and no snapshot semantics. The first version was kept and the conflict surfaced rather than silently resolved.`,
    );
  }
  if (identity.orphanRecords > 0) {
    limitations.push(
      `${identity.orphanRecords} record(s) carried no native session id. Their usage is preserved in \`orphan\` rather than dropped.`,
    );
  }
  if (input.bindings.some((binding) => binding.origin === "runtimeCursor")) {
    limitations.push(
      "Only the newest native session id per thread is durable on `provider_session_runtime`; earlier ids survive only when the caller also supplies append-only `provider_session_history` bindings.",
    );
  }
  if (!input.bindings.some((binding) => binding.origin === "sessionHistory")) {
    limitations.push(
      "No durable session-history bindings were supplied. A resume, fork, or restart that overwrote the cursor leaves earlier usage unattributed to the thread.",
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
      `  ${sessionLabel(session.provider, session.sessionId)} [${session.identityQuality}/${session.measurementQuality}/${session.allocation}] ${tokens}${cost} ${prompts} ${requests} threads=${
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
    `Orphan: ${projection.orphan.totalTokens} tokens`,
    `Measured: ${projection.measured.totalTokens} tokens`,
    "",
    "Coverage:",
  );
  for (const entry of projection.coverage) {
    lines.push(
      `  ${entry.provider} session=${entry.session} prompt=${entry.prompt} request=${entry.request} measured=${entry.measuredSessions} partial=${entry.partialSessions} missing=${entry.missingSessions} unbound=${entry.unboundSessions} ambiguous=${entry.ambiguousSessions} orphanRecords=${entry.recordsWithoutSessionId}`,
    );
  }
  return lines.join("\n");
}
