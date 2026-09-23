import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Append-only pre-execution route and experiment metadata.
 *
 * This is low-cardinality metadata about a routing decision, not conversation
 * content: which provider/model/effort was requested, the pre-execution task
 * stratum, the experiment/cohort, the readable manager/agent identifiers, the
 * route event kind, and any escalation reason. T3 only carries the metadata;
 * the canonical policy that chooses a route lives in agent-config.
 *
 * `route_event_kind` is nullable so an automatic "this is what was requested"
 * event is distinguishable from a declared canary/fallback/escalation event.
 * Observed (actual) values are deliberately NOT stored here: they must come
 * from measured usage, never be copied from the request.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_route_events (
      event_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      native_session_id TEXT,
      route_event_kind TEXT,
      task_stratum TEXT NOT NULL,
      experiment_id TEXT,
      manager_id TEXT,
      agent_id TEXT,
      requested_provider TEXT,
      requested_model TEXT,
      requested_effort TEXT,
      escalation_reason TEXT,
      recorded_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_route_events_thread
    ON thread_route_events(thread_id, recorded_at)
  `;
});
