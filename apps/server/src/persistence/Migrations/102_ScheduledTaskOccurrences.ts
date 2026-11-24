import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One durable record per occurrence of a task an accepted placement owns: its trigger identity is
 * unique per origin, task incarnation and trigger, so a retry or restart resumes the same operation.
 * No foreign key to scheduled_tasks: deleting or recreating a task must not erase an operation
 * whose effect may already have happened.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE scheduled_task_occurrences (
      occurrence_id TEXT PRIMARY KEY,
      origin_environment_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_incarnation TEXT NOT NULL,
      trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('timer', 'manual', 'webhook')),
      trigger_key TEXT NOT NULL,
      owner_ref TEXT,
      command_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      request_key TEXT NOT NULL UNIQUE,
      policy_revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      state TEXT NOT NULL,
      destination_environment_id TEXT,
      destination_project_id TEXT,
      destination_link_incarnation TEXT,
      destination_thread_id TEXT,
      destination_message_id TEXT,
      destination_run_id TEXT,
      outcome_json TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (origin_environment_id, task_id, task_incarnation, trigger_kind, trigger_key)
    )
  `;
  yield* sql`
    CREATE INDEX idx_scheduled_task_occurrences_task
    ON scheduled_task_occurrences (task_id, task_incarnation, created_at)
  `;
});
