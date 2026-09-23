/**
 * Pure parsers for the provider CLIs' on-disk session transcripts.
 *
 * Each parser is a line-at-a-time reducer so callers can stream large files
 * without materialising them. None of them touch the filesystem.
 *
 * @module usageTranscripts
 */
import type { UsageProviderKind, UsageTokenTotals } from "@t3tools/contracts";

/**
 * Whether the source actually measured tokens, as opposed to handing us a
 * container we normalised to zeros.
 *
 * - `observed` — at least one recognised token field held a valid value. An
 *   explicit `0` is a real measured zero and stays `observed`. Whether the
 *   measurement is complete is a separate axis; see
 *   {@link UsageMeasurementCompleteness}.
 * - `empty` — a usage container existed but carried no recognised token field
 *   (for example Claude's `usage: {}`). Numeric totals are zero, but that is a
 *   missing measurement, not a measured zero.
 * - `invalid` — one or more recognised token fields were present but none held
 *   a valid value (`null`, a string, a negative number). This is a malformed
 *   observation, not an absent one.
 * - `unavailable` — the presence information was erased before we saw the
 *   record (a legacy cache row). The zeros may be real or may be missing; we
 *   must not classify them either way.
 */
export type UsageMeasurement = "observed" | "empty" | "invalid" | "unavailable";

/**
 * Whether an `observed` measurement covered every field the provider requires.
 *
 * - `complete` — every required field was present and held a valid value, and
 *   no recognised field was invalid. An explicit all-zero usage object is a
 *   complete measurement.
 * - `partial` — at least one required field was absent or invalid, or a
 *   recognised field held an invalid value. The valid subset is still a real
 *   measurement and its totals are a lower bound, never a complete one.
 *
 * Absent on a record means `complete` for backward compatibility with callers
 * that predate this axis; the parsers always set it for `observed`.
 */
export type UsageMeasurementCompleteness = "complete" | "partial";

/**
 * How far a declared `dedupeKey` can be trusted on its own.
 *
 * - `global` — the key is a globally qualified native observation id (Claude's
 *   `message.id:requestId`, Grok's `sessionId:promptId:model`). Equal keys name
 *   the same observation, so a copy at another path is the same event.
 * - `source-local` — the key is only meaningful within its native session or
 *   occurrence (the scan's Codex occurrence key). It must be qualified by the
 *   native session before it can identify an event, so equal keys in two
 *   sessions are two observations, not one.
 *
 * Absent defaults to `global`.
 */
export type DedupeKeyScope = "global" | "source-local";

/**
 * How a record relates to other records for the same identity.
 *
 * - `delta` — an additive increment (the default for every parser here).
 * - `snapshot` — a cumulative observation that *replaces* an earlier value for
 *   the same identity rather than adding to it. A source that defines updates
 *   sets this; the projection then keeps the newest instead of summing.
 */
export type UsageObservationScope = "delta" | "snapshot";

export interface UsageRecord {
  readonly provider: UsageProviderKind;
  readonly timestampMs: number;
  readonly model: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  readonly reportedCostUsd: number | null;
  /**
   * Key for cross-file de-duplication, or `null` when the record is inherently
   * unique and needs no dedup.
   */
  readonly dedupeKey: string | null;
  /**
   * Native provider request id, when the source exposes one. Claude Code writes
   * a `requestId` per API response. `undefined`/absent must never be read as a
   * request count of one: the source either has the id or it does not.
   *
   * Deliberately separate from {@link dedupeKey}, which is a de-duplication
   * composite and not a guaranteed provider request id.
   */
  readonly providerRequestId?: string | null;
  /**
   * Native provider message id, when the source exposes one. Claude Code's
   * `message.id` identifies one assistant response; it is not a prompt id.
   */
  readonly providerMessageId?: string | null;
  /**
   * Native prompt id, when the source exposes one. Grok Build's
   * `turn_completed.prompt_id` identifies the user prompt a turn answers.
   */
  readonly promptId?: string | null;
  /**
   * Whether the source actually measured this record. Absent means the parser
   * observed recognised fields; a legacy cache row sets `unavailable`
   * explicitly. See {@link UsageMeasurement}.
   */
  readonly measurement?: UsageMeasurement;
  /**
   * Whether an `observed` measurement covered every required field. Only
   * meaningful for `observed`; absent means `complete`. See
   * {@link UsageMeasurementCompleteness}.
   */
  readonly measurementCompleteness?: UsageMeasurementCompleteness;
  /**
   * Count of recognised token fields that were present but held an invalid
   * value. Distinguishes a `partial` measurement with an invalid value from one
   * with an absent field; absent/`0` means no invalid value was seen.
   */
  readonly invalidTokenFields?: number;
  /**
   * `false` when the source erased native identity before we saw it (a legacy
   * cache row). Kept apart from the numeric totals so identity availability is
   * never recovered from token magnitude. Absent means the identity is as the
   * source wrote it.
   */
  readonly identityAvailable?: boolean;
  /**
   * How far `dedupeKey` can be trusted on its own. Absent means `global`. See
   * {@link DedupeKeyScope}.
   */
  readonly dedupeKeyScope?: DedupeKeyScope;
  /** Additive increment or replaceable snapshot. Absent means `delta`. */
  readonly scope?: UsageObservationScope;
}

/**
 * The occurrence-aware identity seam.
 *
 * Two records with the same value here are the same *event shape* in the same
 * session. Callers append a per-delivery occurrence index to distinguish
 * repeated equal events from a re-delivery of one event: a copy of a rollout
 * restarts its occurrence counter, so the copy lands on the same composite key
 * and is de-duplicated, while two genuine equal events in one file land on
 * different keys and are both kept. This is the identity the scan cache stamps
 * onto otherwise-keyless records (see `UsageService`); it is deliberately
 * separate from the native request/message/prompt ids, which are reporting
 * values and not delivery identity.
 */
export function usageEventOccurrenceBaseKey(record: UsageRecord): string {
  return JSON.stringify([
    record.provider,
    record.sessionId,
    record.timestampMs,
    record.model,
    record.totals,
  ]);
}

const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** A token field is valid only as a finite, non-negative number. */
function isValidTokenValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

interface TokenFieldClassification {
  readonly measurement: UsageMeasurement;
  readonly completeness?: UsageMeasurementCompleteness;
  readonly invalidTokenFields: number;
}

/**
 * Classifies a provider usage object by field validity and completeness.
 *
 * Property presence alone is not enough: a field holding `null`, a string, or
 * a negative number is present but invalid, and a usage object missing a
 * required field is a valid known subset rather than a complete measurement.
 * The valid subset is preserved; only the classification says it is partial.
 */
function classifyTokenFields(
  fields: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): TokenFieldClassification {
  let recognized = 0;
  let validRequired = 0;
  let validAny = 0;
  let invalidTokenFields = 0;
  for (const field of [...required, ...optional]) {
    if (!Object.hasOwn(fields, field)) continue;
    recognized += 1;
    if (isValidTokenValue(fields[field])) {
      validAny += 1;
      if (required.includes(field)) validRequired += 1;
    } else {
      invalidTokenFields += 1;
    }
  }
  if (recognized === 0) return { measurement: "empty", invalidTokenFields: 0 };
  if (validAny === 0) return { measurement: "invalid", invalidTokenFields };
  const complete = validRequired === required.length && invalidTokenFields === 0;
  return {
    measurement: "observed",
    completeness: complete ? "complete" : "partial",
    invalidTokenFields,
  };
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function addTotals(a: UsageTokenTotals, b: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export function totalTokens(totals: UsageTokenTotals): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

/**
 * Cheap substring gate applied before `JSON.parse`.
 *
 * Transcripts are mostly tool output; only a minority of lines carry usage. On
 * a 30-day window this skips roughly half the lines outright and is worth about
 * an order of magnitude.
 */
export function mightCarryUsage(line: string, provider: UsageProviderKind): boolean {
  if (provider === "claude") return line.includes('"usage"');
  if (provider === "grok") return line.includes('"turn_completed"');
  return line.includes('"token_count"');
}

/**
 * Grok reports cost in integer ticks where `1 USD = 10^10` ticks. See Grok
 * headless `total_cost_usd_ticks`. Convert to dollars for pricing.
 */
export const GROK_COST_USD_TICKS_PER_DOLLAR = 10_000_000_000;

function grokCostTicksToUsd(ticks: unknown): number | null {
  if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks < 0) return null;
  return ticks / GROK_COST_USD_TICKS_PER_DOLLAR;
}

/* -------------------------------------------------------------------------- */
/* Claude Code                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Token fields that make a Claude `usage` object an actual measurement.
 *
 * `input_tokens` and `output_tokens` are the measurement; the cache fields are
 * genuinely optional and Anthropic omits them when zero, so their absence does
 * not make an otherwise complete record partial.
 */
const CLAUDE_REQUIRED_USAGE_FIELDS = ["input_tokens", "output_tokens"] as const;
const CLAUDE_OPTIONAL_USAGE_FIELDS = [
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;

/**
 * Parses one line of a Claude Code transcript.
 *
 * T3 Code writes one record per assistant *content block*, and every one of
 * those records repeats the same complete `usage` object for the parent
 * message. Summing them overcounts by roughly 2.4x on a real workload, so the
 * caller must drop repeats by `dedupeKey` and keep the first.
 */
export function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0) return null;

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  // Matches ccusage: prefer the message/request pair, fall back to whichever
  // half exists. Records with neither cannot be de-duplicated.
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];

  // `usage: {}` normalises to zeros but is not a measured zero; a field holding
  // `null`, a string, or a negative number is invalid; a missing required field
  // leaves a valid known subset that is only `partial`. Only actual values
  // decide this, never property presence or a nonzero total.
  const classification = classifyTokenFields(
    usageRecord,
    CLAUDE_REQUIRED_USAGE_FIELDS,
    CLAUDE_OPTIONAL_USAGE_FIELDS,
  );

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: {
      uncachedInputTokens: int(usageRecord["input_tokens"]),
      cachedInputTokens: int(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: int(usageRecord["cache_creation_input_tokens"]),
      outputTokens: int(usageRecord["output_tokens"]),
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    dedupeKey,
    // Namespaced identity, kept apart from `dedupeKey`. A user prompt can span
    // several assistant messages (tool continuation), so these count provider
    // requests; no prompt id exists in this source.
    providerRequestId: requestId,
    providerMessageId: messageId,
    promptId: null,
    measurement: classification.measurement,
    ...(classification.completeness === undefined
      ? {}
      : { measurementCompleteness: classification.completeness }),
    ...(classification.invalidTokenFields === 0
      ? {}
      : { invalidTokenFields: classification.invalidTokenFields }),
    // A Claude message/request pair is a globally qualified native observation
    // id: the same response copied into another transcript is the same event.
    dedupeKeyScope: "global",
  };
}

/* -------------------------------------------------------------------------- */
/* Codex                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Rolling state for a single Codex rollout file.
 *
 * Codex `token_count` events carry no model, so the model is carried forward
 * from the most recent `turn_context`. Sessions that switch models mid-run
 * attribute correctly from the switch onward.
 */
export interface CodexScanState {
  model: string;
  sessionId: string;
  lastUsageSignature: string | null;
  sawSessionMeta: boolean;
  /** While true, leading usage events are re-stamped copies of parent history. */
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

export function initialCodexScanState(): CodexScanState {
  return {
    model: "",
    sessionId: "",
    lastUsageSignature: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

/**
 * A forked or subagent rollout opens with the parent's full history copied in,
 * every line re-stamped to the fork instant. Those copies are written in one
 * synchronous burst (observed gaps 0-40ms), while the child's first genuine
 * usage event only lands after a real model turn (observed 5s+). One second of
 * separation splits the two cleanly; `ccusage` uses the same threshold.
 */
const FORK_COPY_MAX_GAP_MS = 1000;

/** Whether a `session_meta` payload marks the rollout as a fork or subagent. */
function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload["forked_from_id"] === "string") return true;
  const source = payload["source"];
  if (typeof source !== "object" || source === null) return false;
  const subagent = (source as Record<string, unknown>)["subagent"];
  if (typeof subagent !== "object" || subagent === null) return false;
  const spawn = (subagent as Record<string, unknown>)["thread_spawn"];
  if (typeof spawn !== "object" || spawn === null) return false;
  return typeof (spawn as Record<string, unknown>)["parent_thread_id"] === "string";
}

/**
 * Feeds one line of a Codex rollout into `state`, returning a record when the
 * line was a usage event.
 *
 * Deltas come from `last_token_usage`. Summing those across a session
 * reconciles with the session's final `total_token_usage`, provided
 * consecutive duplicate events are dropped, which this does.
 */
export function parseCodexLine(line: string, state: CodexScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;
  const payloadType = payloadRecord["type"];

  if (record["type"] === "session_meta") {
    // Only the first meta describes this file's own session. A forked rollout
    // repeats the ancestors' metas right after it; letting those through would
    // reassign every subsequent record to an ancestor session.
    if (state.sawSessionMeta) return null;
    state.sawSessionMeta = true;
    const id = payloadRecord["id"] ?? payloadRecord["session_id"];
    if (typeof id === "string") state.sessionId = id;
    const metaTimestampMs = parseTimestampMs(record["timestamp"]);
    if (metaTimestampMs !== null && isForkedSessionMeta(payloadRecord)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = metaTimestampMs;
    }
    return null;
  }

  if (record["type"] === "turn_context") {
    if (typeof payloadRecord["model"] === "string") state.model = payloadRecord["model"];
    return null;
  }

  if (payloadType !== "token_count") return null;

  const info = payloadRecord["info"];
  if (typeof info !== "object" || info === null) return null;
  const last = (info as Record<string, unknown>)["last_token_usage"];
  if (typeof last !== "object" || last === null) return null;
  const lastRecord = last as Record<string, unknown>;

  // Only an event that is otherwise eligible may consume the duplicate
  // signature. A token_count arriving before its turn_context (no model yet)
  // must not poison it, or the re-emitted copy after the model is known would
  // be skipped as a duplicate and those tokens never counted.
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;
  if (state.model.length === 0) return null;

  // Codex re-emits an unchanged token_count on some stream boundaries. Summing
  // those would double count, so identical consecutive payloads are skipped.
  const signature = JSON.stringify(lastRecord);
  if (signature === state.lastUsageSignature) return null;
  state.lastUsageSignature = signature;

  // In a forked rollout the copied parent history was already counted from the
  // parent's own file. Drop the leading burst; the first usage event separated
  // from its predecessor by a real turn's worth of time ends it for good.
  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs;
      return null;
    }
    state.suppressingForkCopies = false;
  }

  const inputTokens = int(lastRecord["input_tokens"]);
  const cachedInputTokens = int(lastRecord["cached_input_tokens"]);
  const cacheCreationTokens = int(lastRecord["cache_write_input_tokens"]);
  const outputTokens = int(lastRecord["output_tokens"]);

  const totals: UsageTokenTotals = {
    // Codex reports `input_tokens` inclusive of the cached portion.
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    // Reported inside output_tokens, surfaced separately for the token mix.
    reasoningTokens: Math.min(outputTokens, int(lastRecord["reasoning_output_tokens"])),
  };

  if (totalTokens(totals) === 0) return null;

  const classification = classifyTokenFields(
    lastRecord,
    ["input_tokens", "output_tokens"],
    ["cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens"],
  );

  return {
    provider: "codex",
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    totals,
    // Codex does not report cost in the rollout.
    reportedCostUsd: null,
    // Events surviving the fork-copy suppression above are unique to this
    // rollout, so they need no global dedup.
    dedupeKey: null,
    // A `token_count` delta is a turn-level increment with no request or prompt
    // id. Request counts must never be inferred from it.
    providerRequestId: null,
    providerMessageId: null,
    promptId: null,
    // Only emitted when at least one token was measured, so this is observed.
    measurement: "observed",
    ...(classification.completeness === undefined
      ? {}
      : { measurementCompleteness: classification.completeness }),
    ...(classification.invalidTokenFields === 0
      ? {}
      : { invalidTokenFields: classification.invalidTokenFields }),
    // The scan's occurrence key is only meaningful within this session, so a
    // caller stamping it must qualify it with the native session.
    dedupeKeyScope: "source-local",
  };
}

/* -------------------------------------------------------------------------- */
/* Grok Build                                                                 */
/* -------------------------------------------------------------------------- */

interface GrokUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly reasoningTokens: number;
  readonly costUsdTicks: number | null;
  readonly classification: TokenFieldClassification;
}

function readGrokUsageTotals(value: unknown): GrokUsageTotals | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return {
    inputTokens: int(record["inputTokens"]),
    outputTokens: int(record["outputTokens"]),
    cachedReadTokens: int(record["cachedReadTokens"]),
    cacheCreationTokens: int(record["cacheCreationTokens"]),
    reasoningTokens: int(record["reasoningTokens"]),
    costUsdTicks:
      typeof record["costUsdTicks"] === "number" && Number.isFinite(record["costUsdTicks"])
        ? record["costUsdTicks"]
        : null,
    classification: classifyTokenFields(
      record,
      ["inputTokens", "outputTokens"],
      ["cachedReadTokens", "cacheCreationTokens", "reasoningTokens"],
    ),
  };
}

function grokTotalsToUsage(totals: GrokUsageTotals): UsageTokenTotals {
  const cachedInputTokens = totals.cachedReadTokens;
  const cacheCreationTokens = totals.cacheCreationTokens;
  // Grok reports `inputTokens` inclusive of the cached portion, matching Codex.
  const uncachedInputTokens = Math.max(
    0,
    totals.inputTokens - cachedInputTokens - cacheCreationTokens,
  );
  const outputTokens = totals.outputTokens;
  return {
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, totals.reasoningTokens),
  };
}

/**
 * Parses one line of a Grok Build `updates.jsonl` session log.
 *
 * Usage lands on `turn_completed` session updates. Per-model breakdowns live
 * under `usage.modelUsage`; when present each model becomes its own record.
 *
 * Returns every record for the line (0 or more). Callers stream line-by-line
 * and flatten.
 */
export function parseGrokLine(line: string): readonly UsageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];

  const record = parsed as Record<string, unknown>;
  const params = record["params"];
  if (typeof params !== "object" || params === null) return [];
  const paramsRecord = params as Record<string, unknown>;

  const update = paramsRecord["update"];
  if (typeof update !== "object" || update === null) return [];
  const updateRecord = update as Record<string, unknown>;
  if (updateRecord["sessionUpdate"] !== "turn_completed") return [];

  const usage = updateRecord["usage"];
  if (typeof usage !== "object" || usage === null) return [];
  const usageRecord = usage as Record<string, unknown>;

  const sessionId = typeof paramsRecord["sessionId"] === "string" ? paramsRecord["sessionId"] : "";
  const promptId = typeof updateRecord["prompt_id"] === "string" ? updateRecord["prompt_id"] : null;

  // Prefer the high-resolution agent clock; fall back to the outer unix seconds.
  const meta = paramsRecord["_meta"];
  let timestampMs: number | null = null;
  if (typeof meta === "object" && meta !== null) {
    const agentTimestampMs = (meta as Record<string, unknown>)["agentTimestampMs"];
    if (typeof agentTimestampMs === "number" && Number.isFinite(agentTimestampMs)) {
      timestampMs = agentTimestampMs;
    }
  }
  if (timestampMs === null) {
    const timestamp = record["timestamp"];
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
      timestampMs = timestamp > 1e12 ? timestamp : timestamp * 1000;
    }
  }
  if (timestampMs === null) return [];

  const topLevel = readGrokUsageTotals(usageRecord);
  if (topLevel === null) return [];

  const modelUsage = usageRecord["modelUsage"];
  const modelEntries: Array<{ model: string; totals: GrokUsageTotals }> = [];
  if (typeof modelUsage === "object" && modelUsage !== null) {
    for (const [model, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
      if (model.length === 0) continue;
      const totals = readGrokUsageTotals(raw);
      if (totals === null) continue;
      modelEntries.push({ model, totals });
    }
  }

  if (modelEntries.length === 0) {
    if (totalTokens(grokTotalsToUsage(topLevel)) === 0) return [];
    return [
      {
        provider: "grok",
        timestampMs,
        model: "grok",
        sessionId,
        totals: grokTotalsToUsage(topLevel),
        reportedCostUsd: grokCostTicksToUsd(topLevel.costUsdTicks),
        // No prompt id means we cannot tell two same-second updates apart.
        dedupeKey: promptId === null ? null : `${sessionId}:${promptId}:grok`,
        // Grok identifies the prompt, not the API request.
        providerRequestId: null,
        providerMessageId: null,
        promptId,
        measurement: topLevel.classification.measurement,
        ...(topLevel.classification.completeness === undefined
          ? {}
          : { measurementCompleteness: topLevel.classification.completeness }),
        ...(topLevel.classification.invalidTokenFields === 0
          ? {}
          : { invalidTokenFields: topLevel.classification.invalidTokenFields }),
        // `sessionId:promptId:model` is a session-qualified native observation
        // id: the same turn copied into another transcript is the same event.
        dedupeKeyScope: "global",
      },
    ];
  }

  // Cost allocation:
  // 1. Emitted models with their own costUsdTicks keep those values.
  // 2. Remaining aggregate cost (top-level minus those per-model ticks,
  //    clamped at 0) is pro-rated across emitted models that lack ticks,
  //    by token share among the unticked models only.
  // 3. When no model has per-model ticks, remaining equals the full
  //    aggregate and every emitted model gets a token-share slice.
  // Zero-token rows are never emitted and never count toward used ticks.
  const topLevelCostUsd = grokCostTicksToUsd(topLevel.costUsdTicks);
  let usedTickedCostUsd = 0;
  let untickedTokenDenominator = 0;
  for (const entry of modelEntries) {
    const tokens = totalTokens(grokTotalsToUsage(entry.totals));
    if (tokens === 0) continue;
    if (entry.totals.costUsdTicks !== null) {
      usedTickedCostUsd += grokCostTicksToUsd(entry.totals.costUsdTicks) ?? 0;
    } else {
      untickedTokenDenominator += tokens;
    }
  }
  const remainingCostUsd =
    topLevelCostUsd === null ? null : Math.max(0, topLevelCostUsd - usedTickedCostUsd);

  const results: UsageRecord[] = [];
  for (const entry of modelEntries) {
    const totals = grokTotalsToUsage(entry.totals);
    if (totalTokens(totals) === 0) continue;

    let reportedCostUsd = grokCostTicksToUsd(entry.totals.costUsdTicks);
    if (reportedCostUsd === null && remainingCostUsd !== null && untickedTokenDenominator > 0) {
      reportedCostUsd = remainingCostUsd * (totalTokens(totals) / untickedTokenDenominator);
    }

    results.push({
      provider: "grok",
      timestampMs,
      model: entry.model,
      sessionId,
      totals,
      reportedCostUsd,
      dedupeKey: promptId === null ? null : `${sessionId}:${promptId}:${entry.model}`,
      // Grok identifies the prompt, not the API request.
      providerRequestId: null,
      providerMessageId: null,
      promptId,
      measurement: entry.totals.classification.measurement,
      ...(entry.totals.classification.completeness === undefined
        ? {}
        : { measurementCompleteness: entry.totals.classification.completeness }),
      ...(entry.totals.classification.invalidTokenFields === 0
        ? {}
        : { invalidTokenFields: entry.totals.classification.invalidTokenFields }),
      dedupeKeyScope: "global",
    });
  }
  return results;
}

export { EMPTY_TOTALS };
