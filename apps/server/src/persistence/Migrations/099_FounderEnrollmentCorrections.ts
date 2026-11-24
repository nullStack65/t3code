import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Corrects two mistakes 098 made, on databases that already applied it as well as new ones.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Bot sessions skip founder enforcement, so only server-issued ones keep the type. CLI-issued
  // sessions record no network metadata and MCP sessions have their own subject; any other bot was
  // a client's own claim or a crawler-like user agent.
  yield* sql`
    UPDATE auth_sessions
    SET client_device_type = 'unknown'
    WHERE client_device_type = 'bot'
      AND subject IS NOT 'mcp-client'
      AND (client_ip_address IS NOT NULL OR client_user_agent IS NOT NULL)
  `;

  // 098 bound each device to its newest unrevoked founder session even when that session had
  // expired. Replay its choice as of when it ran, and where an expired session decided it, move the
  // device and the sessions that inherited from it since to the live choice, or to no founder.
  // setFounder only touches live sessions, so an expired session still holds the founder 098 read.
  yield* sql`
    CREATE TEMP TABLE founder_backfill_corrections AS
    WITH ran AS (
      SELECT strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AS at
      FROM effect_sql_migrations
      WHERE migration_id = 98
    ),
    replayed AS (
      SELECT
        device.proof_key_thumbprint AS key,
        device.founder AS current,
        ran.at AS ran_at,
        (
          SELECT session.founder
          FROM auth_sessions AS session
          WHERE session.proof_key_thumbprint = device.proof_key_thumbprint
            AND session.issued_at <= ran.at
            AND (session.revoked_at IS NULL OR session.revoked_at > ran.at)
            AND session.founder IS NOT NULL
          ORDER BY session.issued_at DESC
          LIMIT 1
        ) AS bound,
        (
          SELECT session.founder
          FROM auth_sessions AS session
          WHERE session.proof_key_thumbprint = device.proof_key_thumbprint
            AND session.issued_at <= ran.at
            AND (session.revoked_at IS NULL OR session.revoked_at > ran.at)
            AND session.expires_at > ran.at
            AND session.founder IS NOT NULL
          ORDER BY session.issued_at DESC
          LIMIT 1
        ) AS live
      FROM auth_connect_devices AS device, ran
    )
    SELECT key, bound, live, ran_at
    FROM replayed
    WHERE bound IS NOT NULL AND current = bound AND live IS NOT bound
  `;
  yield* sql`
    UPDATE auth_sessions
    SET founder = (
      SELECT correction.live
      FROM founder_backfill_corrections AS correction
      WHERE correction.key = auth_sessions.proof_key_thumbprint
    )
    WHERE EXISTS (
      SELECT 1
      FROM founder_backfill_corrections AS correction
      WHERE correction.key = auth_sessions.proof_key_thumbprint
        AND auth_sessions.issued_at > correction.ran_at
        AND auth_sessions.founder = correction.bound
    )
  `;
  yield* sql`
    UPDATE auth_connect_devices
    SET founder = (
      SELECT correction.live
      FROM founder_backfill_corrections AS correction
      WHERE correction.key = auth_connect_devices.proof_key_thumbprint
    )
    WHERE proof_key_thumbprint IN (SELECT key FROM founder_backfill_corrections)
  `;
  yield* sql`DROP TABLE founder_backfill_corrections`;
});
