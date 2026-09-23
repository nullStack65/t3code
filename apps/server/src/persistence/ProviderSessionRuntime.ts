import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  AgentSessionImportSource,
  IsoDateTime,
  ProviderInstanceId,
  ProviderSessionRuntimeStatus,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

import {
  normalizeTaskStratum,
  type RouteEventInput,
  type RouteSelectionMetadata,
} from "../usage/routeMetadata.ts";

import {
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
  type ProviderSessionRuntimeRepositoryError,
} from "./Errors.ts";

/**
 * ProviderSessionRuntimeRepository - Repository interface for provider runtime sessions.
 *
 * Owns persistence operations for provider runtime metadata and resume cursors.
 *
 * @module ProviderSessionRuntimeRepository
 */

export const ProviderSessionRuntime = Schema.Struct({
  threadId: ThreadId,
  providerName: Schema.String,
  /**
   * User-defined routing key for the configured provider instance that
   * owns this session. Nullable only at the storage/migration boundary:
   * rows persisted before the driver/instance split carry only
   * `providerName`. Repository consumers must materialize a concrete
   * instance id before routing.
   */
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  adapterKey: Schema.String,
  runtimeMode: RuntimeMode,
  status: ProviderSessionRuntimeStatus,
  lastSeenAt: IsoDateTime,
  resumeCursor: Schema.NullOr(Schema.Unknown),
  runtimePayload: Schema.NullOr(Schema.Unknown),
});
export type ProviderSessionRuntime = typeof ProviderSessionRuntime.Type;

export const GetProviderSessionRuntimeInput = Schema.Struct({ threadId: ThreadId });
export type GetProviderSessionRuntimeInput = typeof GetProviderSessionRuntimeInput.Type;

export const DeleteProviderSessionRuntimeInput = Schema.Struct({ threadId: ThreadId });
export type DeleteProviderSessionRuntimeInput = typeof DeleteProviderSessionRuntimeInput.Type;

export const RecordImportedTranscriptInput = Schema.Struct({
  threadId: ThreadId,
  source: AgentSessionImportSource,
});
export type RecordImportedTranscriptInput = typeof RecordImportedTranscriptInput.Type;

export interface ProviderSessionRuntimeUpsertOptions {
  readonly onConflict?: "update" | "ignore";
  /**
   * Additive attribution metadata. Never changes the runtime row itself; it
   * only appends to `provider_session_history` (identity) and
   * `thread_route_events` (pre-execution route/experiment metadata).
   */
  readonly attribution?: ProviderSessionRuntimeAttributionOptions;
}

export interface ProviderSessionRuntimeAttributionOptions {
  /** True sub-agent parent native session id, when the caller knows it. */
  readonly parentNativeSessionId?: string | null;
  /** What this session was asked to run. Recorded, never treated as observed. */
  readonly requestedRoute?: RouteSelectionMetadata | null;
  /** Full declared route/experiment event, when the route authority supplies it. */
  readonly routeEvent?: RouteEventInput | null;
}

/**
 * ProviderSessionRuntimeRepository - Service tag for provider runtime persistence.
 */
export class ProviderSessionRuntimeRepository extends Context.Service<
  ProviderSessionRuntimeRepository,
  {
    /**
     * Insert or replace a provider runtime row.
     *
     * Upserts by canonical `threadId`, retaining imported transcript records
     * from the current database row.
     */
    readonly upsert: (
      runtime: ProviderSessionRuntime,
      options?: ProviderSessionRuntimeUpsertOptions,
    ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;

    /** Record one source file without replacing the current session state. */
    readonly recordImportedTranscript: (
      input: RecordImportedTranscriptInput,
    ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;

    /**
     * Read provider runtime state by canonical thread id.
     */
    readonly getByThreadId: (
      input: GetProviderSessionRuntimeInput,
    ) => Effect.Effect<
      Option.Option<ProviderSessionRuntime>,
      ProviderSessionRuntimeRepositoryError
    >;

    /**
     * List all provider runtime rows.
     *
     * Returned in ascending last-seen order.
     */
    readonly list: () => Effect.Effect<
      ReadonlyArray<ProviderSessionRuntime>,
      ProviderSessionRuntimeRepositoryError
    >;

    /**
     * Delete provider runtime state by canonical thread id.
     */
    readonly deleteByThreadId: (
      input: DeleteProviderSessionRuntimeInput,
    ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;
  }
>()("t3/persistence/ProviderSessionRuntime/ProviderSessionRuntimeRepository") {}

const ProviderSessionRuntimeDbRowSchema = ProviderSessionRuntime.mapFields(
  Struct.assign({
    resumeCursor: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
    runtimePayload: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  }),
);

const ProviderSessionRuntimeRawDbRowSchema = Schema.Struct({
  threadId: Schema.String,
  providerName: Schema.Unknown,
  providerInstanceId: Schema.Unknown,
  adapterKey: Schema.Unknown,
  runtimeMode: Schema.Unknown,
  status: Schema.Unknown,
  lastSeenAt: Schema.Unknown,
  resumeCursor: Schema.Unknown,
  runtimePayload: Schema.Unknown,
});

const decodeRuntimeRow = Schema.decodeUnknownEffect(ProviderSessionRuntimeDbRowSchema);

const GetRuntimeRequestSchema = Schema.Struct({
  threadId: ThreadId,
});

const DeleteRuntimeRequestSchema = GetRuntimeRequestSchema;

const RecordImportedTranscriptRequestSchema = RecordImportedTranscriptInput.mapFields(
  Struct.assign({ source: Schema.fromJsonString(AgentSessionImportSource) }),
);

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): ProviderSessionRuntimeRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Runtime writes can carry stale payloads. Only recordImportedTranscript may
  // change source records, so restore that field from the row being updated.
  const upsertRuntimeRow = SqlSchema.void({
    Request: ProviderSessionRuntimeDbRowSchema,
    execute: (runtime) =>
      sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          ${runtime.threadId},
          ${runtime.providerName},
          ${runtime.providerInstanceId},
          ${runtime.adapterKey},
          ${runtime.runtimeMode},
          ${runtime.status},
          ${runtime.lastSeenAt},
          ${runtime.resumeCursor},
          CASE
            WHEN json_type(${runtime.runtimePayload}) = 'object'
            THEN json_remove(${runtime.runtimePayload}, '$.importedTranscripts')
            ELSE ${runtime.runtimePayload}
          END
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          provider_name = excluded.provider_name,
          provider_instance_id = excluded.provider_instance_id,
          adapter_key = excluded.adapter_key,
          runtime_mode = excluded.runtime_mode,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at,
          resume_cursor_json = excluded.resume_cursor_json,
          runtime_payload_json = CASE
            WHEN json_type(
              CASE
                WHEN json_valid(provider_session_runtime.runtime_payload_json)
                THEN provider_session_runtime.runtime_payload_json
                ELSE '{}'
              END,
              '$.importedTranscripts'
            ) IS NOT NULL
            THEN json_set(
              CASE
                WHEN json_type(excluded.runtime_payload_json) = 'object'
                THEN excluded.runtime_payload_json
                ELSE '{}'
              END,
              '$.importedTranscripts',
              json_extract(provider_session_runtime.runtime_payload_json, '$.importedTranscripts')
            )
            ELSE excluded.runtime_payload_json
          END
      `,
  });

  const insertRuntimeRow = SqlSchema.void({
    Request: ProviderSessionRuntimeDbRowSchema,
    execute: (runtime) =>
      sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          ${runtime.threadId},
          ${runtime.providerName},
          ${runtime.providerInstanceId},
          ${runtime.adapterKey},
          ${runtime.runtimeMode},
          ${runtime.status},
          ${runtime.lastSeenAt},
          ${runtime.resumeCursor},
          CASE
            WHEN json_type(${runtime.runtimePayload}) = 'object'
            THEN json_remove(${runtime.runtimePayload}, '$.importedTranscripts')
            ELSE ${runtime.runtimePayload}
          END
        )
        ON CONFLICT (thread_id) DO NOTHING
      `,
  });

  /**
   * The three cursor shapes adapters write: `{ resume }` (Claude),
   * `{ threadId }` (Codex), `{ sessionId }` (Grok, OpenCode, Antigravity).
   * The value arrives here JSON-encoded, so it is parsed defensively.
   */
  const nativeSessionIdOf = (cursor: unknown): string | null => {
    let parsed: unknown = cursor;
    if (typeof cursor === "string") {
      if (cursor.length === 0) return null;
      try {
        parsed = JSON.parse(cursor);
      } catch {
        return null;
      }
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    for (const field of ["resume", "threadId", "sessionId"] as const) {
      const value = record[field];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return null;
  };

  const recordSessionHistoryRow = SqlSchema.void({
    Request: Schema.Struct({
      threadId: Schema.String,
      providerName: Schema.String,
      providerInstanceId: Schema.NullOr(Schema.String),
      adapterKey: Schema.String,
      nativeSessionId: Schema.String,
      parentNativeSessionId: Schema.NullOr(Schema.String),
      seenAt: Schema.String,
    }),
    execute: (entry) =>
      sql`
        INSERT INTO provider_session_history (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          native_session_id,
          parent_native_session_id,
          origin,
          first_seen_at,
          last_seen_at
        )
        VALUES (
          ${entry.threadId},
          ${entry.providerName},
          ${entry.providerInstanceId},
          ${entry.adapterKey},
          ${entry.nativeSessionId},
          ${entry.parentNativeSessionId},
          'runtimeCursor',
          ${entry.seenAt},
          ${entry.seenAt}
        )
        ON CONFLICT (thread_id, provider_name, native_session_id)
        DO UPDATE SET
          adapter_key = excluded.adapter_key,
          provider_instance_id = COALESCE(
            excluded.provider_instance_id,
            provider_session_history.provider_instance_id
          ),
          last_seen_at = CASE
            WHEN excluded.last_seen_at > provider_session_history.last_seen_at
            THEN excluded.last_seen_at
            ELSE provider_session_history.last_seen_at
          END,
          parent_native_session_id = COALESCE(
            provider_session_history.parent_native_session_id,
            excluded.parent_native_session_id
          )
      `,
  });

  const recordRouteEventRow = SqlSchema.void({
    Request: Schema.Struct({
      eventId: Schema.String,
      threadId: Schema.String,
      nativeSessionId: Schema.NullOr(Schema.String),
      routeEventKind: Schema.NullOr(Schema.String),
      taskStratum: Schema.String,
      experimentId: Schema.NullOr(Schema.String),
      managerId: Schema.NullOr(Schema.String),
      agentId: Schema.NullOr(Schema.String),
      requestedProvider: Schema.NullOr(Schema.String),
      requestedModel: Schema.NullOr(Schema.String),
      requestedEffort: Schema.NullOr(Schema.String),
      escalationReason: Schema.NullOr(Schema.String),
      recordedAt: Schema.String,
    }),
    execute: (event) =>
      sql`
        INSERT OR IGNORE INTO thread_route_events (
          event_id,
          thread_id,
          native_session_id,
          route_event_kind,
          task_stratum,
          experiment_id,
          manager_id,
          agent_id,
          requested_provider,
          requested_model,
          requested_effort,
          escalation_reason,
          recorded_at
        )
        VALUES (
          ${event.eventId},
          ${event.threadId},
          ${event.nativeSessionId},
          ${event.routeEventKind},
          ${event.taskStratum},
          ${event.experimentId},
          ${event.managerId},
          ${event.agentId},
          ${event.requestedProvider},
          ${event.requestedModel},
          ${event.requestedEffort},
          ${event.escalationReason},
          ${event.recordedAt}
        )
      `,
  });

  /**
   * Builds the route events a single upsert implies. At most two: an automatic
   * request record (what T3 was asked to run) and, when supplied, one declared
   * experiment/fallback/escalation event. Ids are deterministic so repeated
   * status writes collapse instead of accumulating duplicates.
   */
  const routeEventsFor = (
    runtime: {
      readonly threadId: string;
      readonly providerName: string;
      readonly providerInstanceId: string | null;
      readonly adapterKey: string;
      readonly lastSeenAt: string;
      readonly resumeCursor: unknown;
    },
    attribution: ProviderSessionRuntimeAttributionOptions | undefined,
    nativeSessionId: string | null,
  ): ReadonlyArray<{
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
    readonly recordedAt: string;
  }> => {
    const events = [];
    const requested = attribution?.requestedRoute ?? null;
    if (
      requested !== null &&
      (requested.provider ?? requested.model ?? requested.effort) !== null
    ) {
      events.push({
        eventId: `${runtime.threadId}::request::${nativeSessionId ?? "unbound"}`,
        threadId: runtime.threadId,
        nativeSessionId,
        routeEventKind: null,
        taskStratum: "unknown",
        experimentId: null,
        managerId: null,
        agentId: null,
        requestedProvider: requested.provider,
        requestedModel: requested.model,
        requestedEffort: requested.effort,
        escalationReason: null,
        recordedAt: runtime.lastSeenAt,
      });
    }
    const declared = attribution?.routeEvent;
    if (declared !== undefined && declared !== null) {
      const kind = declared.kind ?? null;
      events.push({
        eventId:
          declared.eventId?.trim() ||
          `${runtime.threadId}::declared::${kind ?? "unclassified"}::${nativeSessionId ?? "thread"}`,
        threadId: runtime.threadId,
        nativeSessionId: declared.nativeSessionId ?? nativeSessionId,
        routeEventKind: kind,
        taskStratum: normalizeTaskStratum(declared.taskStratum),
        experimentId: declared.experimentId ?? null,
        managerId: declared.managerId ?? null,
        agentId: declared.agentId ?? null,
        requestedProvider: declared.requested?.provider ?? null,
        requestedModel: declared.requested?.model ?? null,
        requestedEffort: declared.requested?.effort ?? null,
        escalationReason: declared.reason ?? null,
        recordedAt: runtime.lastSeenAt,
      });
    }
    return events;
  };

  const recordImportedTranscriptRow = SqlSchema.void({
    Request: RecordImportedTranscriptRequestSchema,
    execute: ({ threadId, source }) =>
      sql`
        WITH current_runtime AS (
          SELECT CASE
            WHEN json_valid(runtime_payload_json) THEN CASE
              WHEN json_type(runtime_payload_json) = 'object' THEN runtime_payload_json
              ELSE '{}'
            END
            ELSE '{}'
          END AS payload
          FROM provider_session_runtime
          WHERE thread_id = ${threadId}
        )
        UPDATE provider_session_runtime
        SET runtime_payload_json = (
          SELECT json_set(
            payload,
            '$.importedTranscripts',
            json((
              SELECT json_group_array(json(value))
              FROM (
                SELECT value
                FROM json_each(CASE
                  WHEN json_type(payload, '$.importedTranscripts') = 'array'
                  THEN json_extract(payload, '$.importedTranscripts')
                  ELSE '[]'
                END)
                WHERE CASE
                  WHEN type = 'object' THEN
                    json_extract(value, '$.providerInstanceId')
                      IS NOT json_extract(${source}, '$.providerInstanceId')
                    OR json_extract(value, '$.filePath') IS NOT json_extract(${source}, '$.filePath')
                  ELSE 0
                END
                UNION ALL
                SELECT ${source} AS value
              )
            ))
          )
          FROM current_runtime
        )
        WHERE thread_id = ${threadId}
      `,
  });

  const getRuntimeRowByThreadId = SqlSchema.findOneOption({
    Request: GetRuntimeRequestSchema,
    Result: ProviderSessionRuntimeRawDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          adapter_key AS "adapterKey",
          runtime_mode AS "runtimeMode",
          status,
          last_seen_at AS "lastSeenAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        WHERE thread_id = ${threadId}
      `,
  });

  const listRuntimeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderSessionRuntimeRawDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          adapter_key AS "adapterKey",
          runtime_mode AS "runtimeMode",
          status,
          last_seen_at AS "lastSeenAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        ORDER BY last_seen_at ASC, thread_id ASC
      `,
  });

  const deleteRuntimeByThreadId = SqlSchema.void({
    Request: DeleteRuntimeRequestSchema,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM provider_session_runtime
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProviderSessionRuntimeRepository["Service"]["upsert"] = (runtime, options) =>
    Effect.gen(function* () {
      if (options?.onConflict === "ignore") {
        // A conflicting write is a stale caller; it must not append history for
        // a cursor that was never applied.
        yield* insertRuntimeRow(runtime);
        return;
      }
      yield* upsertRuntimeRow(runtime);
      const attribution = options?.attribution;
      const nativeSessionId = nativeSessionIdOf(runtime.resumeCursor);
      if (nativeSessionId !== null) {
        yield* recordSessionHistoryRow({
          threadId: runtime.threadId,
          providerName: runtime.providerName,
          providerInstanceId: runtime.providerInstanceId,
          adapterKey: runtime.adapterKey,
          nativeSessionId,
          parentNativeSessionId: attribution?.parentNativeSessionId ?? null,
          seenAt: runtime.lastSeenAt,
        });
      }
      for (const event of routeEventsFor(runtime, attribution, nativeSessionId)) {
        yield* recordRouteEventRow(event);
      }
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.upsert:query",
          "ProviderSessionRuntimeRepository.upsert:encodeRequest",
          { threadId: runtime.threadId },
        ),
      ),
    );

  const recordImportedTranscript: ProviderSessionRuntimeRepository["Service"]["recordImportedTranscript"] =
    (input) =>
      recordImportedTranscriptRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProviderSessionRuntimeRepository.recordImportedTranscript:query",
            "ProviderSessionRuntimeRepository.recordImportedTranscript:encodeRequest",
            { threadId: input.threadId },
          ),
        ),
      );

  const getByThreadId: ProviderSessionRuntimeRepository["Service"]["getByThreadId"] = (input) =>
    getRuntimeRowByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.getByThreadId:query",
          "ProviderSessionRuntimeRepository.getByThreadId:decodeRow",
          { threadId: input.threadId },
        ),
      ),
      Effect.flatMap((runtimeRowOption) =>
        Option.match(runtimeRowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeRuntimeRow(row).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "ProviderSessionRuntimeRepository.getByThreadId:decodeRow",
                  cause,
                  { threadId: input.threadId },
                ),
              ),
              Effect.map((runtime) => Option.some(runtime)),
            ),
        }),
      ),
    );

  const list: ProviderSessionRuntimeRepository["Service"]["list"] = () =>
    listRuntimeRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.list:query",
          "ProviderSessionRuntimeRepository.list:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        // Skip rows that no longer decode (e.g. written by an older build)
        // instead of failing the whole list — one stale row must not disable
        // every consumer that enumerates sessions, such as the reaper.
        Effect.forEach(rows, (row) =>
          decodeRuntimeRow(row).pipe(
            Effect.map(Option.some),
            Effect.catch((cause) =>
              Effect.logWarning("provider.session.runtime.row-skipped", {
                threadId: row.threadId,
                error: PersistenceDecodeError.fromSchemaError(
                  "ProviderSessionRuntimeRepository.list:decodeRows",
                  cause,
                  { threadId: row.threadId },
                ).message,
              }).pipe(Effect.as(Option.none<ProviderSessionRuntime>())),
            ),
          ),
        ),
      ),
      Effect.map((decoded) =>
        Arr.filterMap(decoded, (row) =>
          Option.isSome(row) ? Result.succeed(row.value) : Result.failVoid,
        ),
      ),
    );

  const deleteByThreadId: ProviderSessionRuntimeRepository["Service"]["deleteByThreadId"] = (
    input,
  ) =>
    deleteRuntimeByThreadId(input).pipe(
      Effect.mapError(
        (cause) =>
          new PersistenceSqlError({
            operation: "ProviderSessionRuntimeRepository.deleteByThreadId:query",
            correlation: { threadId: input.threadId },
            cause,
          }),
      ),
    );

  return {
    upsert,
    recordImportedTranscript,
    getByThreadId,
    list,
    deleteByThreadId,
  } satisfies ProviderSessionRuntimeRepository["Service"];
});

export const layer = Layer.effect(ProviderSessionRuntimeRepository, make);
