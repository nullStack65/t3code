/**
 * Read-only extraction of the persisted identities the attribution projection
 * consumes.
 *
 * `buildUsageAttribution` is pure and takes already-normalized bindings and
 * links; this module is the smallest seam that proves those can be read from
 * what the server actually writes:
 *
 * - native session → thread from `provider_session_runtime.resume_cursor_json`
 *   (the single current cursor) and `runtime_payload_json.importedTranscripts`
 *   (the accumulated imported-file history);
 * - thread → pull request from `projection_thread_pull_requests`.
 *
 * It reads only allowlisted fields and never returns a runtime payload. What it
 * cannot read — an absent cursor, a malformed payload, a cursor overwritten by
 * a later session, or one native session bound to two threads — is reported in
 * `diagnostics` rather than silently dropped.
 *
 * @module usageAttributionSources
 */
import type { ThreadPullRequestLinkSource, UsageProviderKind } from "@t3tools/contracts";

import type { AttributionPullRequestLink, AttributionThreadBinding } from "./usageAttribution.ts";
import {
  isRouteEventKind,
  normalizeRouteSelection,
  normalizeTaskStratum,
  readOptionalString,
  type PersistedProviderSessionHistoryRow,
  type PersistedRouteEventRow,
  type RouteEventMetadata,
} from "./routeMetadata.ts";

/**
 * Allowlisted `provider_session_runtime` row. This is the shape the repository
 * returns (`resumeCursor` and `runtimePayload` already JSON-decoded).
 */
export interface PersistedProviderSessionRuntimeRow {
  readonly threadId: string;
  readonly providerName: string;
  readonly providerInstanceId: string | null;
  readonly adapterKey: string;
  readonly resumeCursor: unknown;
  readonly runtimePayload: unknown;
}

/**
 * Allowlisted `projection_thread_pull_requests` row. `snapshot_json` and
 * `stack_json` are intentionally not part of the input: the projection needs
 * only the canonical key, the link source, and the link instant.
 */
export interface PersistedThreadPullRequestRow {
  readonly threadId: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url?: string;
  readonly source: ThreadPullRequestLinkSource;
  readonly linkedAt: string;
}

/**
 * One native session identity that exists in persistence, including providers
 * T3 does not scan for usage. M1R can consume this narrow shape for OpenCode
 * without widening `UsageProviderKind` or adding a parser here.
 */
export interface ExtractedNativeSession {
  readonly threadId: string;
  readonly providerName: string;
  readonly adapterKey: string;
  readonly providerInstanceId: string | null;
  readonly nativeSessionId: string;
  readonly origin: "runtimeCursor" | "importedTranscript";
  /**
   * `null` when the provider has no scanned usage source (OpenCode, Antigravity,
   * Cursor). The identity is still exposed; it simply cannot feed token usage
   * in this proof.
   */
  readonly usageProvider: UsageProviderKind | null;
}

export interface AttributionBindingDiagnostics {
  readonly runtimeRows: number;
  readonly runtimeCursorBindings: number;
  readonly importedTranscriptBindings: number;
  /** Rows with neither a cursor nor imported transcripts. */
  readonly absentIdentityRows: number;
  readonly malformedResumeCursors: number;
  readonly malformedRuntimePayloads: number;
  readonly skippedImportedTranscripts: number;
  /** Bindings for a provider T3 does not scan for usage. */
  readonly unsupportedProviderBindings: number;
  /** Threads whose cursor session differs from a retained imported session. */
  readonly overwrittenThreads: number;
  /** Native sessions bound to more than one thread. */
  readonly ambiguousSessionIds: number;
}

export interface AttributionBindingExtraction {
  /** Only bindings for providers with a scanned usage source. */
  readonly bindings: readonly AttributionThreadBinding[];
  /** Every extracted native identity, including unsupported providers. */
  readonly nativeSessions: readonly ExtractedNativeSession[];
  readonly diagnostics: AttributionBindingDiagnostics;
}

export interface AttributionLinkDiagnostics {
  readonly rows: number;
  readonly links: number;
  /** `stack-dismissed` tombstones, preserved for the projection to filter. */
  readonly dismissed: number;
  readonly malformed: number;
}

export interface AttributionLinkExtraction {
  readonly links: readonly AttributionPullRequestLink[];
  readonly diagnostics: AttributionLinkDiagnostics;
}

export interface AttributionSnapshotExtraction {
  /** Read cutoff; associations are as of this instant. */
  readonly cutoffMs: number;
  /**
   * Every binding the projection should consider: the current cursor plus the
   * durable history, so a session the cursor no longer points at still binds.
   */
  readonly bindings: readonly AttributionThreadBinding[];
  readonly nativeSessions: readonly ExtractedNativeSession[];
  /** Append-only native-session identity history, including unmeasured providers. */
  readonly history: readonly ExtractedSessionHistory[];
  readonly links: readonly AttributionPullRequestLink[];
  readonly routeEvents: readonly RouteEventMetadata[];
  readonly diagnostics: {
    readonly bindings: AttributionBindingDiagnostics;
    readonly history: AttributionHistoryDiagnostics;
    readonly routeEvents: AttributionRouteEventDiagnostics;
    readonly links: AttributionLinkDiagnostics;
  };
}

const USAGE_PROVIDER_BY_DRIVER: Readonly<Record<string, UsageProviderKind>> = {
  claude: "claude",
  claudeagent: "claude",
  codex: "codex",
  grok: "grok",
};

const LINK_SOURCES: ReadonlySet<ThreadPullRequestLinkSource> = new Set([
  "manual",
  "created",
  "agent",
  "stack",
  "stack-dismissed",
]);

function usageProviderOf(...names: readonly string[]): UsageProviderKind | null {
  for (const name of names) {
    const mapped = USAGE_PROVIDER_BY_DRIVER[name.trim().toLowerCase()];
    if (mapped !== undefined) return mapped;
  }
  return null;
}

type CursorRead =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" }
  | { readonly kind: "id"; readonly id: string };

/**
 * The cursor shapes adapters actually write. Claude writes `{ resume }` for a
 * live session and `{ threadId, resume }` together for an imported one, so a
 * cursor is not guaranteed to carry exactly one field. `resume` is the native
 * session id and is preferred over `threadId` (the T3 thread id) when both are
 * present; `{ threadId }` alone is Codex, `{ sessionId }` is Grok, OpenCode,
 * and Antigravity. Order matters, so the preference is explicit.
 */
function readResumeCursor(cursor: unknown): CursorRead {
  if (cursor === null || cursor === undefined) return { kind: "absent" };
  if (typeof cursor !== "object" || Array.isArray(cursor)) return { kind: "malformed" };
  const record = cursor as Record<string, unknown>;
  for (const field of ["resume", "threadId", "sessionId"] as const) {
    const value = record[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return { kind: "id", id: value.trim() };
    }
  }
  return { kind: "malformed" };
}

type ImportedRead =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" }
  | { readonly kind: "entries"; readonly entries: readonly unknown[] };

function readImportedTranscripts(payload: unknown): ImportedRead {
  if (payload === null || payload === undefined) return { kind: "absent" };
  if (typeof payload !== "object" || Array.isArray(payload)) return { kind: "malformed" };
  const record = payload as Record<string, unknown>;
  if (!Object.hasOwn(record, "importedTranscripts")) return { kind: "absent" };
  const entries = record["importedTranscripts"];
  if (!Array.isArray(entries)) return { kind: "malformed" };
  return { kind: "entries", entries };
}

interface ValidImportedSource {
  readonly usageProvider: UsageProviderKind;
  readonly providerInstanceId: string;
  readonly providerSessionId: string;
}

/** Mirrors the `AgentSessionImportSource` schema for the fields we bind on. */
function decodeImportedSource(entry: unknown): ValidImportedSource | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const usageProvider = usageProviderOf(
    typeof record["provider"] === "string" ? record["provider"] : "",
  );
  if (usageProvider === null) return null;
  const providerInstanceId = record["providerInstanceId"];
  const providerSessionId = record["providerSessionId"];
  const filePath = record["filePath"];
  if (typeof providerInstanceId !== "string" || providerInstanceId.trim().length === 0) return null;
  if (typeof providerSessionId !== "string" || providerSessionId.trim().length === 0) return null;
  if (typeof filePath !== "string" || filePath.trim().length === 0) return null;
  return {
    usageProvider,
    providerInstanceId: providerInstanceId.trim(),
    providerSessionId: providerSessionId.trim(),
  };
}

/** Reads native-session → thread bindings from persisted runtime rows. */
export function extractAttributionBindings(
  rows: readonly PersistedProviderSessionRuntimeRow[],
): AttributionBindingExtraction {
  const nativeSessions: ExtractedNativeSession[] = [];
  const bindings: AttributionThreadBinding[] = [];
  const sessionThreads = new Map<string, Set<string>>();
  const diagnostics = {
    runtimeRows: rows.length,
    runtimeCursorBindings: 0,
    importedTranscriptBindings: 0,
    absentIdentityRows: 0,
    malformedResumeCursors: 0,
    malformedRuntimePayloads: 0,
    skippedImportedTranscripts: 0,
    unsupportedProviderBindings: 0,
    overwrittenThreads: 0,
    ambiguousSessionIds: 0,
  };

  for (const row of rows) {
    const usageProvider = usageProviderOf(row.providerName, row.adapterKey);

    const cursor = readResumeCursor(row.resumeCursor);
    if (cursor.kind === "malformed") diagnostics.malformedResumeCursors += 1;
    if (cursor.kind === "id") {
      diagnostics.runtimeCursorBindings += 1;
      if (usageProvider === null) diagnostics.unsupportedProviderBindings += 1;
      nativeSessions.push({
        threadId: row.threadId,
        providerName: row.providerName,
        adapterKey: row.adapterKey,
        providerInstanceId: row.providerInstanceId,
        nativeSessionId: cursor.id,
        origin: "runtimeCursor",
        usageProvider,
      });
      if (usageProvider !== null) {
        bindings.push({
          threadId: row.threadId,
          provider: usageProvider,
          providerInstanceId: row.providerInstanceId,
          nativeSessionId: cursor.id,
          origin: "runtimeCursor",
        });
        addSessionThread(sessionThreads, usageProvider, cursor.id, row.threadId);
      }
    }

    const imported = readImportedTranscripts(row.runtimePayload);
    if (imported.kind === "malformed") diagnostics.malformedRuntimePayloads += 1;
    if (imported.kind === "entries") {
      const importedSessionIds = new Set<string>();
      for (const entry of imported.entries) {
        const source = decodeImportedSource(entry);
        if (source === null) {
          diagnostics.skippedImportedTranscripts += 1;
          continue;
        }
        const expectedThreadId = `import:${source.providerInstanceId}:${source.providerSessionId}`;
        // An imported transcript is only a binding for the thread it names.
        if (row.threadId !== expectedThreadId) {
          diagnostics.skippedImportedTranscripts += 1;
          continue;
        }
        diagnostics.importedTranscriptBindings += 1;
        importedSessionIds.add(source.providerSessionId);
        nativeSessions.push({
          threadId: row.threadId,
          providerName: row.providerName,
          adapterKey: row.adapterKey,
          providerInstanceId: source.providerInstanceId,
          nativeSessionId: source.providerSessionId,
          origin: "importedTranscript",
          usageProvider: source.usageProvider,
        });
        bindings.push({
          threadId: row.threadId,
          provider: source.usageProvider,
          providerInstanceId: source.providerInstanceId,
          nativeSessionId: source.providerSessionId,
          origin: "importedTranscript",
        });
        addSessionThread(
          sessionThreads,
          source.usageProvider,
          source.providerSessionId,
          row.threadId,
        );
      }
      // A retained imported session that is not the current cursor means the
      // cursor was overwritten; the earlier identity survives only here.
      if (cursor.kind === "id" && importedSessionIds.size > 0) {
        const differs = [...importedSessionIds].some((id) => id !== cursor.id);
        if (differs) diagnostics.overwrittenThreads += 1;
      }
    }

    // Truly absent: no cursor and no imported-transcript property at all. A
    // malformed value is counted on its own axis, not folded into absence.
    if (cursor.kind === "absent" && imported.kind === "absent") {
      diagnostics.absentIdentityRows += 1;
    }
  }

  for (const threads of sessionThreads.values()) {
    if (threads.size > 1) diagnostics.ambiguousSessionIds += 1;
  }

  return { bindings, nativeSessions, diagnostics };
}

function addSessionThread(
  index: Map<string, Set<string>>,
  provider: UsageProviderKind,
  sessionId: string,
  threadId: string,
): void {
  const key = `${provider}\u0000${sessionId}`;
  const threads = index.get(key) ?? new Set<string>();
  threads.add(threadId);
  index.set(key, threads);
}

const HISTORY_ORIGINS = new Set(["runtimeCursor", "importedTranscript"]);

/**
 * One durable native-session identity read from `provider_session_history`.
 * Unlike the current cursor, every row survives a resume/model switch, so a
 * thread's earlier sessions stay attributable.
 */
export interface ExtractedSessionHistory {
  readonly threadId: string;
  readonly providerName: string;
  readonly adapterKey: string;
  readonly providerInstanceId: string | null;
  readonly nativeSessionId: string;
  readonly parentNativeSessionId: string | null;
  readonly source: "runtimeCursor" | "importedTranscript" | "unknown";
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly usageProvider: UsageProviderKind | null;
}

export interface AttributionHistoryDiagnostics {
  readonly rows: number;
  readonly sessions: number;
  readonly bindings: number;
  readonly withParent: number;
  /** Durable identities for a provider T3 does not scan for usage. */
  readonly unsupportedProviderBindings: number;
  readonly malformed: number;
}

export interface AttributionHistoryExtraction {
  readonly history: readonly ExtractedSessionHistory[];
  /** Only identities for providers with a scanned usage source. */
  readonly bindings: readonly AttributionThreadBinding[];
  readonly diagnostics: AttributionHistoryDiagnostics;
}

/**
 * Reads the append-only session history. Every row is an identity that
 * contributed to the thread, including providers T3 cannot measure yet
 * (exposed as history with `usageProvider: null`, never as a fabricated zero).
 */
export function extractAttributionHistory(
  rows: readonly PersistedProviderSessionHistoryRow[],
): AttributionHistoryExtraction {
  const history: ExtractedSessionHistory[] = [];
  const bindings: AttributionThreadBinding[] = [];
  const diagnostics = {
    rows: rows.length,
    sessions: 0,
    bindings: 0,
    withParent: 0,
    unsupportedProviderBindings: 0,
    malformed: 0,
  };

  for (const row of rows) {
    const threadId = readOptionalString(row.threadId);
    const providerName = readOptionalString(row.providerName);
    const adapterKey = readOptionalString(row.adapterKey);
    const nativeSessionId = readOptionalString(row.nativeSessionId);
    if (
      threadId === null ||
      providerName === null ||
      adapterKey === null ||
      nativeSessionId === null
    ) {
      diagnostics.malformed += 1;
      continue;
    }
    const usageProvider = usageProviderOf(providerName, adapterKey);
    const parentNativeSessionId = readOptionalString(row.parentNativeSessionId);
    diagnostics.sessions += 1;
    if (parentNativeSessionId !== null) diagnostics.withParent += 1;
    history.push({
      threadId,
      providerName,
      adapterKey,
      providerInstanceId: readOptionalString(row.providerInstanceId),
      nativeSessionId,
      parentNativeSessionId,
      source: HISTORY_ORIGINS.has(row.origin)
        ? (row.origin as ExtractedSessionHistory["source"])
        : "unknown",
      firstSeenAt: readOptionalString(row.firstSeenAt) ?? row.lastSeenAt,
      lastSeenAt: row.lastSeenAt,
      usageProvider,
    });
    if (usageProvider === null) {
      diagnostics.unsupportedProviderBindings += 1;
      continue;
    }
    diagnostics.bindings += 1;
    bindings.push({
      threadId,
      provider: usageProvider,
      providerInstanceId: readOptionalString(row.providerInstanceId),
      nativeSessionId,
      origin: "sessionHistory",
    });
  }

  return { history, bindings, diagnostics };
}

export interface AttributionRouteEventDiagnostics {
  readonly rows: number;
  readonly events: number;
  /** Events with a classified kind (canary, fallback, review, escalation). */
  readonly declared: number;
  /** Automatic "what was requested" records with no classified kind. */
  readonly requests: number;
  readonly malformed: number;
}

export interface AttributionRouteEventExtraction {
  readonly events: readonly RouteEventMetadata[];
  readonly diagnostics: AttributionRouteEventDiagnostics;
}

/**
 * Reads the allowlisted fields of `thread_route_events`. Content never crosses
 * this seam: only ids, the requested selection, stratum, cohort, and reason.
 */
export function extractAttributionRouteEvents(
  rows: readonly PersistedRouteEventRow[],
): AttributionRouteEventExtraction {
  const events: RouteEventMetadata[] = [];
  const diagnostics = {
    rows: rows.length,
    events: 0,
    declared: 0,
    requests: 0,
    malformed: 0,
  };

  for (const row of rows) {
    const eventId = readOptionalString(row.eventId);
    const threadId = readOptionalString(row.threadId);
    const recordedAt = readOptionalString(row.recordedAt);
    const rawKind = row.routeEventKind;
    // A non-null kind that is not one of the known kinds is a malformed row,
    // not an unknown-but-valid one.
    if (rawKind !== null && rawKind !== undefined && !isRouteEventKind(rawKind)) {
      diagnostics.malformed += 1;
      continue;
    }
    if (eventId === null || threadId === null || recordedAt === null) {
      diagnostics.malformed += 1;
      continue;
    }
    const requested = normalizeRouteSelection({
      provider: row.requestedProvider,
      model: row.requestedModel,
      effort: row.requestedEffort,
    });
    const kind = isRouteEventKind(rawKind) ? rawKind : null;
    diagnostics.events += 1;
    if (kind === null) diagnostics.requests += 1;
    else diagnostics.declared += 1;
    events.push({
      eventId,
      threadId,
      nativeSessionId: readOptionalString(row.nativeSessionId),
      kind,
      taskStratum: normalizeTaskStratum(row.taskStratum),
      experimentId: readOptionalString(row.experimentId),
      managerId: readOptionalString(row.managerId),
      agentId: readOptionalString(row.agentId),
      requested,
      reason: readOptionalString(row.escalationReason),
      recordedAt,
    });
  }

  return { events, diagnostics };
}

/** Reads thread → PR links from persisted projection rows, dropping payloads. */
export function extractAttributionLinks(
  rows: readonly PersistedThreadPullRequestRow[],
): AttributionLinkExtraction {
  const links: AttributionPullRequestLink[] = [];
  let dismissed = 0;
  let malformed = 0;

  for (const row of rows) {
    if (
      typeof row.threadId !== "string" ||
      row.threadId.length === 0 ||
      typeof row.host !== "string" ||
      row.host.trim().length === 0 ||
      typeof row.repository !== "string" ||
      row.repository.trim().length === 0 ||
      !Number.isSafeInteger(row.number) ||
      row.number <= 0 ||
      !LINK_SOURCES.has(row.source) ||
      typeof row.linkedAt !== "string" ||
      row.linkedAt.length === 0
    ) {
      malformed += 1;
      continue;
    }
    if (row.source === "stack-dismissed") dismissed += 1;
    links.push({
      threadId: row.threadId,
      host: row.host,
      repository: row.repository,
      number: row.number,
      source: row.source,
      linkedAt: row.linkedAt,
      ...(typeof row.url === "string" && row.url.length > 0 ? { url: row.url } : {}),
    });
  }

  return { links, diagnostics: { rows: rows.length, links: links.length, dismissed, malformed } };
}

/** Combined read-only snapshot the projection can be reproduced from. */
export function extractAttributionSnapshot(input: {
  readonly cutoffMs: number;
  readonly runtimeRows: readonly PersistedProviderSessionRuntimeRow[];
  readonly historyRows?: readonly PersistedProviderSessionHistoryRow[];
  readonly linkRows: readonly PersistedThreadPullRequestRow[];
  readonly routeEventRows?: readonly PersistedRouteEventRow[];
}): AttributionSnapshotExtraction {
  const bindings = extractAttributionBindings(input.runtimeRows);
  const history = extractAttributionHistory(input.historyRows ?? []);
  const routeEvents = extractAttributionRouteEvents(input.routeEventRows ?? []);
  const links = extractAttributionLinks(input.linkRows);
  return {
    cutoffMs: input.cutoffMs,
    bindings: [...bindings.bindings, ...history.bindings],
    nativeSessions: bindings.nativeSessions,
    history: history.history,
    links: links.links,
    routeEvents: routeEvents.events,
    diagnostics: {
      bindings: bindings.diagnostics,
      history: history.diagnostics,
      routeEvents: routeEvents.diagnostics,
      links: links.diagnostics,
    },
  };
}
