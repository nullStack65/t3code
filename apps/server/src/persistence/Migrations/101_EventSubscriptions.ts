import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Per-agent event subscriptions. The document is the EventSubscription contract. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS event_subscriptions (
      id TEXT PRIMARY KEY,
      subscriber_thread_id TEXT NOT NULL,
      selector_key TEXT NOT NULL,
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (subscriber_thread_id, selector_key)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS event_subscriptions_selector
    ON event_subscriptions (selector_key)
  `;
});
