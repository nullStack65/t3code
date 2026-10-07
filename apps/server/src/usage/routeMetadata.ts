/**
 * Pure types and parsers for pre-execution route and experiment metadata.
 *
 * T3 carries this metadata so the coding-model canary can be measured across
 * resumes, model switches, child sessions, and retries. T3 does not decide
 * which route a task should take: `route_event_kind` records what the route
 * authority (agent-config policy / an OMP Skill) declared, and the requested
 * selection records what T3 was actually asked to run. Observed/actual values
 * are derived from measured usage elsewhere and are never stored here, so a
 * requested value can never be mistaken for an observed one.
 *
 * Everything is deliberately low-cardinality and content-free: no prompts, no
 * responses, no code, no tool bodies.
 *
 * @module routeMetadata
 */

/** Why a route event happened. `null` means "request only, not classified". */
const ROUTE_EVENT_KINDS = [
  "normal",
  "availability_fallback",
  "canary",
  "independent_review",
  "quality_escalation",
] as const;
export type RouteEventKind = (typeof ROUTE_EVENT_KINDS)[number];

/**
 * A bounded, coarse task class known *before* execution. `unknown` is a first
 * class value: the caller must be able to abstain rather than guess.
 */
const TASK_STRATA = [
  "investigation",
  "docs",
  "tests",
  "simple_edit",
  "implementation",
  "review",
  "ci_repair",
  "architecture",
  "security",
  "unknown",
] as const;
export type TaskStratum = (typeof TASK_STRATA)[number];

const ROUTE_EVENT_KIND_SET: ReadonlySet<string> = new Set(ROUTE_EVENT_KINDS);
const TASK_STRATUM_SET: ReadonlySet<string> = new Set(TASK_STRATA);

export function isRouteEventKind(value: unknown): value is RouteEventKind {
  return typeof value === "string" && ROUTE_EVENT_KIND_SET.has(value);
}

function isTaskStratum(value: unknown): value is TaskStratum {
  return typeof value === "string" && TASK_STRATUM_SET.has(value);
}

/** Coerces anything unrecognized (including `null`) to the `unknown` stratum. */
export function normalizeTaskStratum(value: unknown): TaskStratum {
  return isTaskStratum(value) ? value : "unknown";
}

/** A non-empty trimmed string, or `null`. Never invents a value. */
export function readOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Normalized provider-instance identity key for durable session-history
 * identity.
 *
 * SQLite `UNIQUE` treats `NULL` as distinct, so a nullable instance column
 * cannot express "these are the same instance" — every null would be its own
 * row. The key is therefore a non-null string: a trimmed instance id, or `""`
 * for an unknown/null instance. `""` is a first-class bucket, not a wildcard,
 * so two unknown-instance observations of one `(thread, provider, native
 * session)` collapse to one row while a real instance stays distinct.
 *
 * The migration backfill computes the same value in SQL as
 * `COALESCE(NULLIF(TRIM(provider_instance_id), ''), '')`.
 */
export function normalizeProviderInstanceKey(value: unknown): string {
  const trimmed = readOptionalString(value);
  return trimmed ?? "";
}

/**
 * `escalation_reason` is bounded metadata, not a content channel. Only a
 * low-cardinality code/slug is accepted: lowercase letters, digits, and
 * `_`, `-`, `.`, `:` — no whitespace, no multiline payload. Anything else
 * normalizes to `null` rather than being stored, so arbitrary prose cannot
 * leak into the metadata carrier.
 */
const MAX_ESCALATION_REASON_LENGTH = 64;
const ESCALATION_REASON_PATTERN = /^[a-z0-9][a-z0-9_.:-]*$/;

export function normalizeEscalationReason(value: unknown): string | null {
  const trimmed = readOptionalString(value);
  if (trimmed === null) return null;
  if (trimmed.length > MAX_ESCALATION_REASON_LENGTH) return null;
  return ESCALATION_REASON_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * The provider/model/effort a route decision asked for. Each field is
 * independently optional: a caller that knows the model but not the effort
 * must leave the effort `null` rather than default it.
 */
export interface RouteSelectionMetadata {
  readonly provider: string | null;
  readonly model: string | null;
  readonly effort: string | null;
}

/**
 * How a selection field is grounded.
 * - `declared` — a route event supplied it (requested side).
 * - `observed` — a measured source established it (actual side).
 * - `unsupported` — the source cannot expose the field.
 * - `unknown` — nothing supplied it; never treated as a value.
 */
export type RouteSelectionQuality = "declared" | "observed" | "unsupported" | "unknown";

export function hasRouteSelectionValue(selection: RouteSelectionMetadata | null): boolean {
  return (
    selection !== null &&
    (selection.provider !== null || selection.model !== null || selection.effort !== null)
  );
}

/** Normalizes an arbitrary selection-shaped value; all-null collapses to `null`. */
export function normalizeRouteSelection(value: unknown): RouteSelectionMetadata | null {
  if (value === null || value === undefined || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const selection: RouteSelectionMetadata = {
    provider: readOptionalString(record["provider"]),
    model: readOptionalString(record["model"]),
    effort: readOptionalString(record["effort"]),
  };
  return hasRouteSelectionValue(selection) ? selection : null;
}

/**
 * A normalized, persisted route event.
 *
 * `kind === null` marks an automatic request record (T3 wrote down what it was
 * asked to run) rather than a classified experiment/fallback/escalation event.
 */
export interface RouteEventMetadata {
  readonly eventId: string;
  readonly threadId: string;
  readonly nativeSessionId: string | null;
  readonly kind: RouteEventKind | null;
  readonly taskStratum: TaskStratum;
  readonly experimentId: string | null;
  readonly managerId: string | null;
  readonly agentId: string | null;
  readonly requested: RouteSelectionMetadata | null;
  /** Availability-fallback or quality-escalation reason, when declared. */
  readonly reason: string | null;
  /**
   * `true` when a later automatic request observation disagreed with an
   * already-stored non-null requested field. The stored value is retained
   * (first non-null wins) and the conflict is surfaced rather than silently
   * overwritten.
   */
  readonly selectionConflict: boolean;
  readonly recordedAt: string;
}

/**
 * Input accepted at a write seam. The writer fills missing fields with
 * truthful `null`/`unknown`; it never synthesizes a value.
 */
export interface RouteEventInput {
  readonly eventId?: string;
  readonly nativeSessionId?: string | null;
  readonly kind?: RouteEventKind | null;
  readonly taskStratum?: TaskStratum | null;
  readonly experimentId?: string | null;
  readonly managerId?: string | null;
  readonly agentId?: string | null;
  readonly requested?: RouteSelectionMetadata | null;
  readonly reason?: string | null;
}

/** The allowlisted `thread_route_events` row shape the projection consumes. */
export interface PersistedRouteEventRow {
  readonly eventId: string;
  readonly threadId: string;
  readonly nativeSessionId: string | null;
  readonly routeEventKind: string | null;
  readonly taskStratum: string;
  readonly experimentId: string | null;
  readonly managerId: string | null;
  readonly agentId: string | null;
  readonly requestedProvider: string | null;
  readonly requestedModel: string | null;
  readonly requestedEffort: string | null;
  readonly escalationReason: string | null;
  /** 0/1; `1` when a later request observation conflicted with the stored selection. */
  readonly selectionConflict: number;
  readonly recordedAt: string;
}

/** The allowlisted `provider_session_history` row shape the projection reads. */
export interface PersistedProviderSessionHistoryRow {
  readonly threadId: string;
  readonly providerName: string;
  readonly providerInstanceId: string | null;
  readonly adapterKey: string;
  readonly nativeSessionId: string;
  readonly parentNativeSessionId: string | null;
  readonly origin: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}
