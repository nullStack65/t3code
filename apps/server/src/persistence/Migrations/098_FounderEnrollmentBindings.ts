import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The founder a pairing code enrolls, and the founder an approved T3 Connect device key belongs
 * to. New sessions take their founder only from these, never from earlier sessions.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const hasFounder = (columns: ReadonlyArray<{ readonly name: string }>) =>
    columns.some((column) => column.name === "founder");
  if (!hasFounder(yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_pairing_links)`)) {
    yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN founder TEXT`;
  }
  if (!hasFounder(yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_connect_devices)`)) {
    yield* sql`ALTER TABLE auth_connect_devices ADD COLUMN founder TEXT`;
  }

  // A device someone already assigned keeps that founder through its next hourly renewal.
  yield* sql`
    UPDATE auth_connect_devices
    SET founder = (
      SELECT session.founder
      FROM auth_sessions AS session
      WHERE session.proof_key_thumbprint = auth_connect_devices.proof_key_thumbprint
        AND session.revoked_at IS NULL
        AND session.founder IS NOT NULL
      ORDER BY session.issued_at DESC
      LIMIT 1
    )
    WHERE founder IS NULL
  `;
});
