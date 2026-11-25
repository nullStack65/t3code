import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

const live = "2999-01-01T00:00:00.000Z";
const expired = "2000-01-01T00:00:00.000Z";

interface SeedSession {
  readonly id: string;
  readonly key: string;
  readonly founder: string | null;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
}

const seedFounders = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const key of ["assigned", "lapsed", "unassigned"]) {
    yield* sql`
      INSERT INTO auth_connect_devices (proof_key_thumbprint, approved_at)
      VALUES (${key}, '2026-11-01')
    `;
  }
  yield* insertSessions([
    { id: "old", key: "assigned", founder: "kameron", issuedAt: "2026-11-01T00:00:00.000Z" },
    {
      id: "revoked",
      key: "assigned",
      founder: "jeff",
      issuedAt: "2026-11-02T00:00:00.000Z",
      revokedAt: "2026-11-02T01:00:00.000Z",
    },
    {
      id: "stale",
      key: "assigned",
      founder: "jeff",
      issuedAt: "2026-11-04T00:00:00.000Z",
      expiresAt: expired,
    },
    { id: "blank", key: "assigned", founder: null, issuedAt: "2026-11-03T00:00:00.000Z" },
    { id: "other", key: "unassigned", founder: null, issuedAt: "2026-11-03T00:00:00.000Z" },
    {
      id: "lapsed",
      key: "lapsed",
      founder: "jeff",
      issuedAt: "2026-11-03T00:00:00.000Z",
      expiresAt: expired,
    },
  ]);
});

const insertSessions = (sessions: ReadonlyArray<SeedSession>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const session of sessions) {
      yield* sql`
        INSERT INTO auth_sessions
          (session_id, subject, scopes, method, issued_at, expires_at, revoked_at,
           proof_key_thumbprint, founder)
        VALUES (${session.id}, 't3-connect', '[]', 'bearer-session-token', ${session.issuedAt},
          ${session.expiresAt ?? live}, ${session.revokedAt ?? null}, ${session.key},
          ${session.founder})
      `;
    }
  });

layer("099_FounderEnrollmentCorrections fresh database", (it) => {
  it.effect("binds each Connect device only from a live assigned session", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 97 });
      yield* seedFounders;
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT proof_key_thumbprint, founder FROM auth_connect_devices ORDER BY 1`,
        [
          { proof_key_thumbprint: "assigned", founder: "kameron" },
          { proof_key_thumbprint: "lapsed", founder: null },
          { proof_key_thumbprint: "unassigned", founder: null },
        ],
      );
    }),
  );
});

layer("099_FounderEnrollmentCorrections after 098 applied", (it) => {
  it.effect("undoes bindings 098 took from expired sessions and what inherited them since", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 97 });
      yield* seedFounders;
      yield* sql`
        INSERT INTO auth_connect_devices (proof_key_thumbprint, approved_at)
        VALUES ('moved', '2026-11-01'), ('dropped', '2026-11-01')
      `;
      yield* insertSessions([
        {
          id: "moved-live",
          key: "moved",
          founder: "kameron",
          issuedAt: "2026-11-05T00:00:00.000Z",
        },
        {
          id: "dropped-lapsed",
          key: "dropped",
          founder: "jeff",
          issuedAt: "2026-11-05T00:00:00.000Z",
          expiresAt: expired,
        },
      ]);
      yield* runMigrations({ toMigrationInclusive: 98 });
      assert.deepStrictEqual(
        yield* sql`SELECT proof_key_thumbprint, founder FROM auth_connect_devices ORDER BY 1`,
        [
          { proof_key_thumbprint: "assigned", founder: "jeff" },
          { proof_key_thumbprint: "dropped", founder: "jeff" },
          { proof_key_thumbprint: "lapsed", founder: "jeff" },
          { proof_key_thumbprint: "moved", founder: "kameron" },
          { proof_key_thumbprint: "unassigned", founder: null },
        ],
      );
      yield* sql`
        UPDATE effect_sql_migrations SET created_at = '2026-11-10 00:00:00' WHERE migration_id = 98
      `;

      // Since 098 ran: renewals inherited its bindings, one device was reassigned and one revoked.
      yield* insertSessions([
        {
          id: "assigned-renewed",
          key: "assigned",
          founder: "jeff",
          issuedAt: "2026-11-12T00:00:00.000Z",
        },
        {
          id: "lapsed-renewed",
          key: "lapsed",
          founder: "jeff",
          issuedAt: "2026-11-12T00:00:00.000Z",
        },
      ]);
      yield* sql`UPDATE auth_sessions SET founder = 'jeff' WHERE session_id = 'moved-live'`;
      yield* sql`UPDATE auth_connect_devices SET founder = 'jeff' WHERE proof_key_thumbprint = 'moved'`;
      yield* sql`
        UPDATE auth_connect_devices SET founder = NULL WHERE proof_key_thumbprint = 'dropped'
      `;
      yield* sql`
        INSERT INTO auth_sessions
          (session_id, subject, scopes, method, issued_at, expires_at, client_ip_address,
           client_device_type)
        VALUES ('claimed', 'one-time-token', '[]', 'bearer-access-token', '2026-11-12T00:00:00.000Z', ${live},
          '192.168.1.9', 'bot')
      `;

      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT proof_key_thumbprint, founder FROM auth_connect_devices ORDER BY 1`,
        [
          { proof_key_thumbprint: "assigned", founder: "kameron" },
          { proof_key_thumbprint: "dropped", founder: null },
          { proof_key_thumbprint: "lapsed", founder: null },
          { proof_key_thumbprint: "moved", founder: "jeff" },
          { proof_key_thumbprint: "unassigned", founder: null },
        ],
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT session_id, founder, client_device_type FROM auth_sessions
          WHERE session_id IN ('assigned-renewed', 'lapsed-renewed', 'moved-live', 'stale', 'claimed')
          ORDER BY 1
        `,
        [
          { session_id: "assigned-renewed", founder: "kameron", client_device_type: "unknown" },
          { session_id: "claimed", founder: null, client_device_type: "unknown" },
          { session_id: "lapsed-renewed", founder: null, client_device_type: "unknown" },
          { session_id: "moved-live", founder: "jeff", client_device_type: "unknown" },
          { session_id: "stale", founder: "jeff", client_device_type: "unknown" },
        ],
      );
    }),
  );
});

layer("099_FounderEnrollmentCorrections agent provenance", (it) => {
  it.effect("keeps the bot type only on sessions the server issued to an agent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 98 });
      const sessions = [
        { id: "cli", subject: "cli-issued-session", ipAddress: null, userAgent: null },
        { id: "mcp", subject: "mcp-client", ipAddress: "192.168.1.9", userAgent: "agent" },
        { id: "claimed", subject: "one-time-token", ipAddress: "192.168.1.9", userAgent: null },
        { id: "crawler", subject: "one-time-token", ipAddress: null, userAgent: "curl/8.7.1" },
      ];
      for (const session of sessions) {
        yield* sql`
          INSERT INTO auth_sessions
            (session_id, subject, scopes, method, issued_at, expires_at,
             client_ip_address, client_user_agent, client_device_type)
          VALUES (${session.id}, ${session.subject}, '[]', 'bearer-access-token', '2026-11-01',
            ${live}, ${session.ipAddress}, ${session.userAgent}, 'bot')
        `;
      }
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT session_id, client_device_type FROM auth_sessions ORDER BY 1`,
        [
          { session_id: "claimed", client_device_type: "unknown" },
          { session_id: "cli", client_device_type: "bot" },
          { session_id: "crawler", client_device_type: "unknown" },
          { session_id: "mcp", client_device_type: "bot" },
        ],
      );
    }),
  );
});
