/**
 * Durable per-file scan cache.
 *
 * Transcripts are append-only and a file that has not changed can never yield
 * different usage, so parsed records are keyed by `(size, mtime)` and reused.
 * Without this every server restart re-parses the whole window: roughly 3.5s
 * for a 30-day scan here, against ~11ms to reload this cache.
 *
 * Caching *per file* rather than per day is deliberate. It is timezone
 * independent, so changing the reporting zone does not invalidate anything, and
 * it keeps cross-file de-duplication exact: cached entries are de-duplicated
 * within their own file only, and the aggregator still applies the global
 * dedupe pass over the small surviving key set.
 *
 * @module usageScanCache
 */
import type { UsageProviderKind } from "@t3tools/contracts";

import { GUARD_LENGTH, type TranscriptParsePosition } from "./usageTranscriptReader.ts";
import type {
  CodexScanState,
  DedupeKeyScope,
  UsageMeasurement,
  UsageMeasurementCompleteness,
  UsageObservationScope,
  UsageRecord,
} from "./usageTranscripts.ts";

// v2: Codex fork-copy suppression changed what a file parses to, so v1
// entries would keep serving double-counted records forever.
// v3: entries carry the parse position and reducer state so a grown file
// re-parses only its appended bytes instead of starting over.
// v4: records carry native request/message/prompt ids. Without the bump, warm
// v3 entries would silently report those levels as unsupported until the file
// next changed. The v4 row later gained validity/completeness and dedupe-key
// scope fields appended after the first v4 rows; the version deliberately
// stayed 4 because those fields are additive.
//
// Supported-format policy:
// - v3 documents are still *read*. The scan retains measured records from
//   transcripts that have since been deleted, and those cannot be re-parsed, so
//   discarding a v3 cache would destroy 90 days of history. A v3 row decodes
//   with its native ids and measurement presence explicitly `unavailable`.
// - A v4 row written by the predecessor (15 fields, no quality metadata)
//   decodes conservatively: completeness is `partial`, never `complete`, and
//   the entry is `qualityMetadata: "predecessor"` so an extant file is cold
//   re-parsed once. No row is discarded for the format change.
// - Only v1/v2 (no parse position, different fork semantics) are rejected.
const USAGE_SCAN_CACHE_VERSION = 4 as const;
const LEGACY_USAGE_SCAN_CACHE_VERSION = 3 as const;

/** Index of the first appended post-v4 field (completeness code) in a row. */
const POST_V4_FIELD_INDEX = 15;

/**
 * Whether a cache entry's rows still carry their native ids and measurement
 * presence. A `v3` entry erased both; the projection must report them as
 * unavailable rather than as a measured zero or an absent id.
 */
export type ScanCacheIdentity = "declared" | "unavailable";

/**
 * Whether a cache entry's rows carry the current numeric quality metadata
 * (validity/completeness and dedupe-key scope, appended after the first v4
 * rows). Native-id availability alone does not prove that: a `15`-field v4 row
 * written before that metadata existed has identity `declared` but no
 * completeness, so reading it as complete would silently promote an unknown
 * measurement. Such an entry is `predecessor`: its retained rows are treated as
 * partial, and an extant file is cold re-parsed once to enrich it.
 */
export type ScanCacheQualityMetadata = "declared" | "predecessor";

export interface CachedFile {
  readonly size: number;
  readonly mtimeMs: number;
  readonly provider: UsageProviderKind;
  /** Records from newline-terminated lines, up to `position.resumeOffset`. */
  readonly records: readonly UsageRecord[];
  /**
   * Records from a trailing segment the writer had not newline-terminated at
   * parse time. Kept apart from `records` because an incremental parse
   * re-reads that segment and would otherwise double count it.
   */
  readonly tailRecords: readonly UsageRecord[];
  readonly position: TranscriptParsePosition;
  /**
   * `unavailable` for a legacy row whose ids/presence were erased. Callers must
   * not resume such an entry: a cold re-parse is the only way to enrich it.
   */
  readonly identity: ScanCacheIdentity;
  /**
   * `predecessor` for an entry whose rows omit the current quality metadata.
   * Callers must not serve it warm or resume it: the numeric quality is
   * unasserted, so a cold re-parse is the only way to establish completeness.
   */
  readonly qualityMetadata: ScanCacheQualityMetadata;
}

export type ScanCache = Map<string, CachedFile>;

/**
 * Row layout for the serialised form. Positional and interned rather than
 * object-per-record: on a 30-day window that is the difference between a file
 * measured in tens of megabytes and one under six.
 */
type SerializedRecord = readonly [
  timestampMs: number,
  modelIndex: number,
  sessionIndex: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  dedupeKey: string | null,
  reportedCostUsd: number | null,
  providerRequestId: string | null,
  providerMessageId: string | null,
  promptId: string | null,
  measurementCode: number,
  scopeCode: number,
  /** Appended after the first v4 rows; absent means `complete` when observed. */
  completenessCode: number,
  /** Appended after the first v4 rows; count of present-but-invalid fields. */
  invalidTokenFields: number,
  /** Appended after the first v4 rows; absent means `global`. */
  dedupeKeyScopeCode: number,
];

// `invalid` is appended last so the existing observed/empty/unavailable codes
// keep their values and older v4 rows keep decoding.
const MEASUREMENT_CODES: readonly UsageMeasurement[] = [
  "observed",
  "empty",
  "unavailable",
  "invalid",
];
const SCOPE_CODES: readonly UsageObservationScope[] = ["delta", "snapshot"];
const COMPLETENESS_CODES: readonly UsageMeasurementCompleteness[] = ["complete", "partial"];
const DEDUPE_KEY_SCOPE_CODES: readonly DedupeKeyScope[] = ["global", "source-local"];

function encodeMeasurement(measurement: UsageMeasurement | undefined): number {
  const index = MEASUREMENT_CODES.indexOf(measurement ?? "observed");
  return index < 0 ? 0 : index;
}

function encodeScope(scope: UsageObservationScope | undefined): number {
  const index = SCOPE_CODES.indexOf(scope ?? "delta");
  return index < 0 ? 0 : index;
}

function encodeCompleteness(completeness: UsageMeasurementCompleteness | undefined): number {
  const index = COMPLETENESS_CODES.indexOf(completeness ?? "complete");
  return index < 0 ? 0 : index;
}

function encodeDedupeKeyScope(scope: DedupeKeyScope | undefined): number {
  const index = DEDUPE_KEY_SCOPE_CODES.indexOf(scope ?? "global");
  return index < 0 ? 0 : index;
}

function decodeCode<Value extends string>(
  value: unknown,
  codes: readonly Value[],
): Value | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? codes[value] : undefined;
}

interface SerializedFile {
  readonly s: number;
  readonly m: number;
  readonly p: UsageProviderKind;
  readonly r: readonly SerializedRecord[];
  /** Tail records; see `CachedFile.tailRecords`. */
  readonly t: readonly SerializedRecord[];
  /** Parse position: resume offset, guard length, guard hash. */
  readonly o: number;
  readonly gl: number;
  readonly gh: number;
  /** Codex reducer state at `o`; `null` for stateless providers. */
  readonly cs: CodexScanState | null;
  /**
   * `1` when this entry's rows predate native ids / measurement presence. Kept
   * on the file so an erased-history entry stays `unavailable` across restarts
   * until an extant file is cold re-parsed. Absent on a fresh entry.
   */
  readonly li?: number;
}

interface SerializedCache {
  readonly version: number;
  readonly models: readonly string[];
  readonly sessions: readonly string[];
  readonly files: Readonly<Record<string, SerializedFile>>;
}

/** Serialises the cache, interning the repeated model and session strings. */
export function encodeScanCache(cache: ScanCache): SerializedCache {
  const models: string[] = [];
  const sessions: string[] = [];
  const modelIndex = new Map<string, number>();
  const sessionIndex = new Map<string, number>();

  const intern = (table: string[], index: Map<string, number>, value: string): number => {
    const existing = index.get(value);
    if (existing !== undefined) return existing;
    const next = table.length;
    table.push(value);
    index.set(value, next);
    return next;
  };

  const serializeRecord = (record: UsageRecord): SerializedRecord => [
    record.timestampMs,
    intern(models, modelIndex, record.model),
    intern(sessions, sessionIndex, record.sessionId),
    record.totals.uncachedInputTokens,
    record.totals.cachedInputTokens,
    record.totals.cacheCreationTokens,
    record.totals.outputTokens,
    record.totals.reasoningTokens,
    record.dedupeKey,
    record.reportedCostUsd,
    record.providerRequestId ?? null,
    record.providerMessageId ?? null,
    record.promptId ?? null,
    encodeMeasurement(record.measurement),
    encodeScope(record.scope),
    encodeCompleteness(record.measurementCompleteness),
    record.invalidTokenFields ?? 0,
    encodeDedupeKeyScope(record.dedupeKeyScope),
  ];

  const files: Record<string, SerializedFile> = {};
  for (const [path, entry] of cache) {
    files[path] = {
      s: entry.size,
      m: entry.mtimeMs,
      p: entry.provider,
      r: entry.records.map(serializeRecord),
      t: entry.tailRecords.map(serializeRecord),
      o: entry.position.resumeOffset,
      gl: entry.position.guardLength,
      gh: entry.position.guardHash,
      cs: entry.position.codexState,
      ...(entry.identity === "unavailable" ? { li: 1 } : {}),
    };
  }

  return { version: USAGE_SCAN_CACHE_VERSION, models, sessions, files };
}

function isRecordArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Rebuilds the cache from a parsed document.
 *
 * Anything malformed yields an empty cache rather than an error: a corrupt
 * cache should cost one cold scan, never a broken page.
 */
export function decodeScanCache(document: unknown): ScanCache {
  const cache: ScanCache = new Map();
  if (typeof document !== "object" || document === null) return cache;

  const root = document as Partial<SerializedCache>;
  if (
    root.version !== USAGE_SCAN_CACHE_VERSION &&
    root.version !== LEGACY_USAGE_SCAN_CACHE_VERSION
  ) {
    return cache;
  }
  // A v3 document has no native ids or measurement presence anywhere; every
  // entry it holds is erased-history. A v4 entry carries its own marker.
  const legacyDocument = root.version === LEGACY_USAGE_SCAN_CACHE_VERSION;
  if (!isRecordArray(root.models) || !isRecordArray(root.sessions)) return cache;
  if (typeof root.files !== "object" || root.files === null) return cache;

  // The intern tables must be all strings: a numeric entry would pass the
  // undefined guard below, land in a record's model, and crash the aggregate
  // at lookupRate. A corrupt table rejects the whole cache.
  if (!root.models.every((value) => typeof value === "string")) return cache;
  if (!root.sessions.every((value) => typeof value === "string")) return cache;
  const models = root.models as readonly string[];
  const sessions = root.sessions as readonly string[];

  // Any corrupt row disqualifies the whole entry. Keeping the survivors
  // under the original (size, mtime) would read as a valid warm hit and the
  // file would never be re-parsed, silently losing the dropped rows' usage.
  const decodeRecords = (
    rows: readonly unknown[],
    provider: UsageProviderKind,
    legacy: boolean,
  ): { records: UsageRecord[]; qualityDeclared: boolean } | null => {
    const records: UsageRecord[] = [];
    // Every row must carry the appended post-v4 fields for the entry to be
    // current. A 15-field row was written before completeness existed; the
    // entry's numeric quality is then unasserted and must not be read as
    // complete. Empty row lists are vacuously current: there is no measurement
    // to promote.
    let qualityDeclared = true;
    for (const row of rows) {
      if (!isRecordArray(row) || row.length < 10) return null;
      if (row.length <= POST_V4_FIELD_INDEX) qualityDeclared = false;
      const [
        timestampMs,
        modelIndex,
        sessionIndex,
        uncached,
        cached,
        cacheCreation,
        output,
        reasoning,
        dedupeKey,
        reportedCostUsd,
      ] = row as SerializedRecord;
      // Appended in v4. Absent on a hand-built or truncated row, in which case
      // the identity is simply not asserted rather than defaulted to a value.
      const providerRequestId = row[10];
      const providerMessageId = row[11];
      const promptId = row[12];
      // Appended after v4. A v3 or early-v4 row has no presence information, so
      // a nonzero total proves a measurement while an all-zero row stays
      // explicitly `unavailable` rather than being read as a measured zero.
      const measurementCode = row[13];
      const scopeCode = row[14];
      // Appended after the first v4 rows: validity/completeness metadata. Absent
      // on an older row, whose completeness is then unasserted (`partial`).
      const completenessCode = row[15];
      const invalidTokenFieldsRaw = row[16];
      const dedupeKeyScopeCode = row[17];

      const model = typeof modelIndex === "number" ? models[modelIndex] : undefined;
      if (
        typeof timestampMs !== "number" ||
        !Number.isFinite(timestampMs) ||
        model === undefined ||
        !Number.isFinite(uncached) ||
        !Number.isFinite(cached) ||
        !Number.isFinite(cacheCreation) ||
        !Number.isFinite(output) ||
        !Number.isFinite(reasoning)
      ) {
        return null;
      }

      const measurement: UsageMeasurement =
        decodeCode(measurementCode, MEASUREMENT_CODES) ??
        (uncached + cached + cacheCreation + output > 0 ? "observed" : "unavailable");
      const scope: UsageObservationScope = decodeCode(scopeCode, SCOPE_CODES) ?? "delta";
      // A row that omits the completeness code proves nothing about coverage,
      // whether it is a legacy row (presence erased) or a predecessor v4 row
      // (metadata predates the field). Default to `partial`, never `complete`:
      // missing quality metadata must not be silently promoted to a measured
      // complete observation. The current writer always emits the code, so this
      // only applies to older rows.
      const completeness: UsageMeasurementCompleteness | undefined =
        measurement === "observed"
          ? (decodeCode(completenessCode, COMPLETENESS_CODES) ?? "partial")
          : undefined;
      const invalidTokenFields =
        typeof invalidTokenFieldsRaw === "number" &&
        Number.isFinite(invalidTokenFieldsRaw) &&
        invalidTokenFieldsRaw > 0
          ? Math.trunc(invalidTokenFieldsRaw)
          : 0;
      const dedupeKeyScope: DedupeKeyScope | undefined = decodeCode(
        dedupeKeyScopeCode,
        DEDUPE_KEY_SCOPE_CODES,
      );

      records.push({
        provider,
        timestampMs,
        model,
        sessionId: (typeof sessionIndex === "number" ? sessions[sessionIndex] : undefined) ?? "",
        totals: {
          uncachedInputTokens: uncached,
          cachedInputTokens: cached,
          cacheCreationTokens: cacheCreation,
          outputTokens: output,
          reasoningTokens: reasoning,
        },
        reportedCostUsd: typeof reportedCostUsd === "number" ? reportedCostUsd : null,
        dedupeKey: typeof dedupeKey === "string" ? dedupeKey : null,
        // A v3 row cannot carry native ids; they are unavailable, not absent.
        ...(legacy
          ? {}
          : {
              ...(typeof providerRequestId === "string" ? { providerRequestId } : {}),
              ...(typeof providerMessageId === "string" ? { providerMessageId } : {}),
              ...(typeof promptId === "string" ? { promptId } : {}),
            }),
        measurement,
        ...(completeness === undefined ? {} : { measurementCompleteness: completeness }),
        ...(invalidTokenFields === 0 ? {} : { invalidTokenFields }),
        // Legacy rows erased identity; keep that visible so the projection does
        // not read an absent native id as a missing one.
        ...(legacy ? { identityAvailable: false } : {}),
        ...(dedupeKeyScope === undefined ? {} : { dedupeKeyScope }),
        ...(scope === "delta" ? {} : { scope }),
      });
    }
    return { records, qualityDeclared };
  };

  for (const [path, raw] of Object.entries(root.files)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Partial<SerializedFile>;
    if (typeof entry.s !== "number" || typeof entry.m !== "number") continue;
    if (entry.p !== "claude" && entry.p !== "codex" && entry.p !== "grok") continue;
    if (!isRecordArray(entry.r) || !isRecordArray(entry.t)) continue;
    // Position fields feed byte offsets and a Buffer allocation in the reader,
    // so anything outside their real ranges must reject the entry: a bogus
    // guard length would otherwise fail every parse of the file, silently
    // dropping its usage instead of costing the documented cold re-parse.
    if (
      typeof entry.o !== "number" ||
      !Number.isSafeInteger(entry.o) ||
      entry.o < 0 ||
      typeof entry.gl !== "number" ||
      !Number.isSafeInteger(entry.gl) ||
      entry.gl < 0 ||
      entry.gl > GUARD_LENGTH ||
      entry.gl > entry.o ||
      typeof entry.gh !== "number" ||
      !Number.isFinite(entry.gh)
    ) {
      continue;
    }
    const codexState = decodeCodexState(entry.cs);
    if (codexState === undefined) continue;

    const provider: UsageProviderKind = entry.p;
    const legacy = legacyDocument || entry.li === 1;
    const decodedRecords = decodeRecords(entry.r, provider, legacy);
    const decodedTail = decodeRecords(entry.t, provider, legacy);
    if (decodedRecords === null || decodedTail === null) continue;

    cache.set(path, {
      size: entry.s,
      mtimeMs: entry.m,
      provider,
      records: decodedRecords.records,
      tailRecords: decodedTail.records,
      position: {
        resumeOffset: entry.o,
        guardLength: entry.gl,
        guardHash: entry.gh,
        codexState,
      },
      identity: legacy ? "unavailable" : "declared",
      qualityMetadata:
        decodedRecords.qualityDeclared && decodedTail.qualityDeclared ? "declared" : "predecessor",
    });
  }

  return cache;
}

/**
 * Validates a persisted Codex reducer state. Returns `undefined` for a corrupt
 * value, which disqualifies the entry: resuming with a bad state would attach
 * appended usage to the wrong model or replay fork-copied history.
 */
function decodeCodexState(value: unknown): CodexScanState | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const state = value as Partial<CodexScanState>;
  if (
    typeof state.model !== "string" ||
    typeof state.sessionId !== "string" ||
    (state.lastUsageSignature !== null && typeof state.lastUsageSignature !== "string") ||
    typeof state.sawSessionMeta !== "boolean" ||
    typeof state.suppressingForkCopies !== "boolean" ||
    typeof state.forkCopyAnchorMs !== "number" ||
    !Number.isFinite(state.forkCopyAnchorMs)
  ) {
    return undefined;
  }
  return {
    model: state.model,
    sessionId: state.sessionId,
    lastUsageSignature: state.lastUsageSignature ?? null,
    sawSessionMeta: state.sawSessionMeta,
    suppressingForkCopies: state.suppressingForkCopies,
    forkCopyAnchorMs: state.forkCopyAnchorMs,
  };
}

/** Keeps saved usage after transcript cleanup, until the reporting retention expires. */
export function pruneScanCache(cache: ScanCache, retentionCutoffMs: number): number {
  let removed = 0;
  for (const [path, entry] of cache) {
    if (entry.mtimeMs < retentionCutoffMs) {
      cache.delete(path);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Within-file de-duplication, applied before an entry is cached.
 *
 * Callers stitching an incremental parse together pass one `seen` set across
 * the line and tail record batches so the whole file stays deduplicated as a
 * unit; the set is mutated in place.
 */
export function dedupeWithinFile(
  records: readonly UsageRecord[],
  seen: Set<string> = new Set(),
): readonly UsageRecord[] {
  const kept: UsageRecord[] = [];
  for (const record of records) {
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
    }
    kept.push(record);
  }
  return kept;
}
