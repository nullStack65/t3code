import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Append-only native-session identity history per T3 thread.
 *
 * `provider_session_runtime` keeps a single current `resume_cursor_json`. A
 * resume, fork, or model switch overwrites it, so earlier native sessions that
 * contributed to a thread become unrecoverable. This table records one row per
 * durable identity so a thread can answer which native sessions it used even
 * after the cursor moved on. Repeated observations of the same identity only
 * advance `last_seen_at`; they never replace a different session's row.
 *
 * Identity includes the configured provider instance, not just the provider
 * name. Two instances of one driver can expose the same native session id on
 * one thread (for example native OpenCode Go and a CLIProxyAPI loopback), and
 * collapsing them would erase which instance produced the session. SQLite
 * treats `NULL` as distinct in `UNIQUE`, so the instance is stored as a
 * normalized non-null `provider_instance_key`: a trimmed instance id, or `""`
 * for an unknown/null instance. `""` is a deterministic bucket, so two
 * unknown-instance observations collapse to one row while a real instance
 * stays distinct. The runtime writer computes the same key in JS via
 * `normalizeProviderInstanceKey`.
 *
 * The backfill seeds the table from whatever cursor already exists so an
 * upgraded database does not start empty. Its id selection mirrors the runtime
 * `nativeSessionIdOf` semantics exactly: only a JSON text value that is
 * non-empty after trimming is accepted, and the precedence `resume` →
 * `threadId` → `sessionId` falls through to the next candidate on any absent,
 * null, non-string, or blank value. A numeric/boolean/object cursor never
 * becomes an id.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_session_history (
      history_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      provider_instance_id TEXT,
      provider_instance_key TEXT NOT NULL,
      adapter_key TEXT NOT NULL,
      native_session_id TEXT NOT NULL,
      parent_native_session_id TEXT,
      origin TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE (thread_id, provider_name, provider_instance_key, native_session_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_session_history_thread
    ON provider_session_history(thread_id, first_seen_at)
  `;

  yield* sql`
    INSERT OR IGNORE INTO provider_session_history (
      thread_id,
      provider_name,
      provider_instance_id,
      provider_instance_key,
      adapter_key,
      native_session_id,
      parent_native_session_id,
      origin,
      first_seen_at,
      last_seen_at
    )
    SELECT
      current.thread_id,
      current.provider_name,
      current.provider_instance_id,
      COALESCE(NULLIF(TRIM(current.provider_instance_id), ''), ''),
      current.adapter_key,
      current.native_session_id,
      NULL,
      'runtimeCursor',
      current.last_seen_at,
      current.last_seen_at
    FROM (
      SELECT
        runtime.thread_id,
        runtime.provider_name,
        runtime.provider_instance_id,
        runtime.adapter_key,
        runtime.last_seen_at,
        CASE
          WHEN json_type(runtime.cursor, '$.resume') = 'text'
            AND TRIM(json_extract(runtime.cursor, '$.resume')) <> ''
          THEN TRIM(json_extract(runtime.cursor, '$.resume'))
          WHEN json_type(runtime.cursor, '$.threadId') = 'text'
            AND TRIM(json_extract(runtime.cursor, '$.threadId')) <> ''
          THEN TRIM(json_extract(runtime.cursor, '$.threadId'))
          WHEN json_type(runtime.cursor, '$.sessionId') = 'text'
            AND TRIM(json_extract(runtime.cursor, '$.sessionId')) <> ''
          THEN TRIM(json_extract(runtime.cursor, '$.sessionId'))
          ELSE NULL
        END AS native_session_id
      FROM (
        SELECT
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          last_seen_at,
          CASE
            WHEN resume_cursor_json IS NOT NULL AND json_valid(resume_cursor_json)
            THEN resume_cursor_json
            ELSE NULL
          END AS cursor
        FROM provider_session_runtime
      ) AS runtime
    ) AS current
    WHERE current.native_session_id IS NOT NULL
  `;
});
