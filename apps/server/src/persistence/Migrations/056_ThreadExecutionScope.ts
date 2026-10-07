import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "execution_scope")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN execution_scope TEXT`;
  }
  // Historical threads keep null: upgrading never rebinds an active provider or rewrites history.
});
