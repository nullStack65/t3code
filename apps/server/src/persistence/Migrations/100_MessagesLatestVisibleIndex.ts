import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A thread shell reads its newest visible message by `updated_at`. Only user messages had a
 * matching index, so every other read sorted the thread's whole history and parsed each user
 * message's JSON to filter it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_thread_updated_idx
    ON orchestration_v2_projection_messages(thread_id, updated_at DESC, message_id DESC)
  `;
});
