import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const names = new Set(columns.map((column) => column.name));

  if (!names.has("owner")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN owner TEXT
    `;
  }
  if (!names.has("thread_type")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN thread_type TEXT
    `;
  }
  if (!names.has("started_by")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN started_by TEXT
    `;
  }
});
