import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Who an admin says uses a signed-in client, so messages sent from it name that person.
 * Null until someone assigns it; nothing guesses a value for existing sessions.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;
  if (!columns.some((column) => column.name === "founder")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN founder TEXT
    `;
  }
});
