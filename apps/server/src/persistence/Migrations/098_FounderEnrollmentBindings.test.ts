import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("098_FounderEnrollmentBindings", (it) => {
  it.effect("binds each Connect device to the founder of its newest live assigned session", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 97 });
      for (const key of ["assigned", "unassigned"]) {
        yield* sql`
          INSERT INTO auth_connect_devices (proof_key_thumbprint, approved_at)
          VALUES (${key}, '2026-11-01')
        `;
      }
      const sessions = [
        { id: "old", key: "assigned", founder: "kameron", issuedAt: "2026-11-01", revokedAt: null },
        { id: "revoked", key: "assigned", founder: "jeff", issuedAt: "2026-11-02", revokedAt: "x" },
        { id: "blank", key: "assigned", founder: null, issuedAt: "2026-11-03", revokedAt: null },
        { id: "other", key: "unassigned", founder: null, issuedAt: "2026-11-03", revokedAt: null },
      ];
      for (const session of sessions) {
        yield* sql`
          INSERT INTO auth_sessions
            (session_id, subject, scopes, method, issued_at, expires_at, revoked_at,
             proof_key_thumbprint, founder)
          VALUES (${session.id}, 't3-connect', '[]', 'bearer-session-token', ${session.issuedAt},
            '2026-12-01', ${session.revokedAt}, ${session.key}, ${session.founder})
        `;
      }
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT proof_key_thumbprint, founder FROM auth_connect_devices ORDER BY 1`,
        [
          { proof_key_thumbprint: "assigned", founder: "kameron" },
          { proof_key_thumbprint: "unassigned", founder: null },
        ],
      );
      yield* sql`UPDATE auth_pairing_links SET founder = 'jeff'`;
    }),
  );
});
