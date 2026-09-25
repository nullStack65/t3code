import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

interface HistoryRow {
  readonly threadId: string;
  readonly providerName: string;
  readonly nativeSessionId: string;
  readonly parentNativeSessionId: string | null;
  readonly origin: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

layer("054_ProviderSessionHistory", (it) => {
  it.effect("creates the history tables and backfills the current cursor", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 53 });

      const insertRuntime = (threadId: string, providerName: string, cursor: string | null) =>
        sql`
          INSERT INTO provider_session_runtime (
            thread_id,
            provider_name,
            provider_instance_id,
            adapter_key,
            runtime_mode,
            status,
            last_seen_at,
            resume_cursor_json,
            runtime_payload_json
          )
          VALUES (
            ${threadId},
            ${providerName},
            ${providerName},
            ${providerName},
            'full-access',
            'running',
            '2026-09-23T09:00:00.000Z',
            ${cursor},
            NULL
          )
        `;

      yield* insertRuntime("thread-codex", "codex", '{"threadId":"session-a"}');
      yield* insertRuntime("thread-claude", "claudeAgent", '{"resume":"session-b"}');
      // No recognised id field: nothing to backfill.
      yield* insertRuntime("thread-unknown", "codex", '{"opaque":true}');
      // No cursor at all.
      yield* insertRuntime("thread-absent", "codex", null);

      yield* runMigrations({ toMigrationInclusive: 55 });

      const rows = yield* sql<HistoryRow>`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          native_session_id AS "nativeSessionId",
          parent_native_session_id AS "parentNativeSessionId",
          origin,
          first_seen_at AS "firstSeenAt",
          last_seen_at AS "lastSeenAt"
        FROM provider_session_history
        ORDER BY native_session_id ASC
      `;

      assert.deepStrictEqual(rows, [
        {
          threadId: "thread-codex",
          providerName: "codex",
          nativeSessionId: "session-a",
          parentNativeSessionId: null,
          origin: "runtimeCursor",
          firstSeenAt: "2026-09-23T09:00:00.000Z",
          lastSeenAt: "2026-09-23T09:00:00.000Z",
        },
        {
          threadId: "thread-claude",
          providerName: "claudeAgent",
          nativeSessionId: "session-b",
          parentNativeSessionId: null,
          origin: "runtimeCursor",
          firstSeenAt: "2026-09-23T09:00:00.000Z",
          lastSeenAt: "2026-09-23T09:00:00.000Z",
        },
      ]);

      const routeEventCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM thread_route_events
      `;
      assert.equal(routeEventCount[0]!.count, 0);

      // The unique key is on the durable identity, so a repeat cannot duplicate.
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(provider_session_history)
      `;
      assert.ok(indexes.length > 0);
    }),
  );

  it("registers both migrations in the manifest", () => {
    const entries = new Set(migrationManifest.map(([id, name]) => `${id}_${name}`));
    assert.ok(entries.has("54_ProviderSessionHistory"));
    assert.ok(entries.has("55_ThreadRouteEvents"));
  });
});
