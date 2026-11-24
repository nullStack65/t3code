import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("100_MessagesLatestVisibleIndex", (it) => {
  it.effect("serves a thread's newest message of any role in index order, with no sort", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const plan = (yield* sql.unsafe<{ readonly detail: string }>(`
        EXPLAIN QUERY PLAN
        SELECT message.message_id
        FROM orchestration_v2_projection_messages message
          INDEXED BY orchestration_v2_projection_messages_thread_updated_idx
        WHERE message.thread_id = 'thread' AND NOT (message.role = 'user' AND message.streaming = 2)
        ORDER BY message.updated_at DESC, message.message_id DESC
        LIMIT 1
      `))
        .map((row) => row.detail)
        .join("\n");
      assert.include(plan, "USING INDEX orchestration_v2_projection_messages_thread_updated_idx");
      assert.notInclude(plan, "TEMP B-TREE");
    }),
  );
});
