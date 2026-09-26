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
  readonly providerInstanceKey: string;
  readonly nativeSessionId: string;
  readonly parentNativeSessionId: string | null;
  readonly origin: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

layer("054_ProviderSessionHistory", (it) => {
  it.effect("backfills the current cursor with runtime nativeSessionIdOf semantics", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 53 });

      const insertRuntime = (
        threadId: string,
        providerName: string,
        cursor: string | null,
        providerInstanceId: string | null = providerName,
      ) => {
        const instanceJson = providerInstanceId === null ? null : providerInstanceId;
        return sql`
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
            ${instanceJson},
            ${providerName},
            'full-access',
            'running',
            '2026-09-23T09:00:00.000Z',
            ${cursor},
            NULL
          )
        `;
      };

      // Valid text resume.
      yield* insertRuntime("thread-resume", "claudeAgent", '{"resume":"resume-id"}');
      // Empty/whitespace resume falls through to a valid threadId.
      yield* insertRuntime(
        "thread-empty-resume",
        "claudeAgent",
        '{"resume":"","threadId":"thread-id-fallback"}',
      );
      // Non-string resume falls through to a valid threadId.
      yield* insertRuntime(
        "thread-nonstring-resume",
        "codex",
        '{"resume":123,"threadId":"thread-id-2"}',
      );
      // Blank resume and threadId fall through to a valid sessionId.
      yield* insertRuntime(
        "thread-session-fallback",
        "codex",
        '{"resume":"","threadId":"   ","sessionId":"session-id-3"}',
      );
      // Whitespace-only text fields are ignored entirely.
      yield* insertRuntime("thread-whitespace", "codex", '{"resume":"   ","threadId":"   "}');
      // Non-string candidates never become an id.
      yield* insertRuntime("thread-number-only", "codex", '{"resume":123}');
      yield* insertRuntime("thread-bool-only", "codex", '{"threadId":true}');
      yield* insertRuntime("thread-object-only", "codex", '{"sessionId":{"nested":1}}');
      // No recognised id field.
      yield* insertRuntime("thread-unknown", "codex", '{"opaque":true}');
      // No cursor at all.
      yield* insertRuntime("thread-absent", "codex", null);
      // A null provider instance uses the deterministic empty-string key.
      yield* insertRuntime("thread-null-instance", "codex", '{"resume":"null-instance-id"}', null);
      // A whitespace-padded instance id is trimmed in the key.
      yield* insertRuntime(
        "thread-trimmed-instance",
        "codex",
        '{"resume":"trimmed-id"}',
        "  codex-x  ",
      );

      yield* runMigrations({ toMigrationInclusive: 55 });

      const rows = yield* sql<HistoryRow>`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          provider_instance_key AS "providerInstanceKey",
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
          threadId: "thread-null-instance",
          providerName: "codex",
          providerInstanceKey: "",
          nativeSessionId: "null-instance-id",
          parentNativeSessionId: null,
          origin: "runtimeCursor",
          firstSeenAt: "2026-09-23T09:00:00.000Z",
          lastSeenAt: "2026-09-23T09:00:00.000Z",
        },
        {
          threadId: "thread-resume",
          providerName: "claudeAgent",
          providerInstanceKey: "claudeAgent",
          nativeSessionId: "resume-id",
          parentNativeSessionId: null,
          origin: "runtimeCursor",
          firstSeenAt: "2026-09-23T09:00:00.000Z",
          lastSeenAt: "2026-09-23T09:00:00.000Z",
        },
        {
          threadId: "thread-session-fallback",
          providerName: "codex",
          providerInstanceKey: "codex",
          nativeSessionId: "session-id-3",
          parentNativeSessionId: null,
          origin: "runtimeCursor",
          firstSeenAt: "2026-09-23T09:00:00.000Z",
          lastSeenAt: "2026-09-23T09:00:00.000Z",
        },
        {
          threadId: "thread-nonstring-resume",
          providerName: "codex",
          providerInstanceKey: "codex",
          nativeSessionId: "thread-id-2",
          parentNativeSessionId: null,
          origin: "runtimeCursor",
          firstSeenAt: "2026-09-23T09:00:00.000Z",
          lastSeenAt: "2026-09-23T09:00:00.000Z",
        },
        {
          threadId: "thread-empty-resume",
          providerName: "claudeAgent",
          providerInstanceKey: "claudeAgent",
          nativeSessionId: "thread-id-fallback",
          parentNativeSessionId: null,
          origin: "runtimeCursor",
          firstSeenAt: "2026-09-23T09:00:00.000Z",
          lastSeenAt: "2026-09-23T09:00:00.000Z",
        },
        {
          threadId: "thread-trimmed-instance",
          providerName: "codex",
          providerInstanceKey: "codex-x",
          nativeSessionId: "trimmed-id",
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

      // The unique key is on the durable identity (including the provider
      // instance key), so a repeat cannot duplicate.
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(provider_session_history)
      `;
      assert.ok(indexes.length > 0);

      // Migration rerun is idempotent: no new rows, no duplicate backfill.
      yield* runMigrations({ toMigrationInclusive: 55 });
      const afterRerun = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM provider_session_history
      `;
      assert.equal(afterRerun[0]!.count, rows.length);
    }),
  );

  it("registers both migrations in the manifest", () => {
    const entries = new Set(migrationManifest.map(([id, name]) => `${id}_${name}`));
    assert.ok(entries.has("54_ProviderSessionHistory"));
    assert.ok(entries.has("55_ThreadRouteEvents"));
  });
});
