import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const at = "2026-11-18T12:00:00.000Z";

layer("102_ScheduledTaskOccurrences", (it) => {
  it.effect("keeps one occurrence per trigger identity, independent of the task row", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 97 });
      const occurrence = (id: string, overrides: Record<string, unknown> = {}) =>
        sql`INSERT INTO scheduled_task_occurrences ${sql.insert({
          occurrence_id: id,
          origin_environment_id: "environment-origin",
          // No task row exists: an operation outlives its task's deletion or replacement.
          task_id: "task:gone",
          task_incarnation: "incarnation-1",
          trigger_kind: "timer",
          trigger_key: at,
          owner_ref: null,
          command_id: `command:${id}`,
          message_id: `message:${id}`,
          request_key: `request:${id}`,
          policy_revision: 1,
          snapshot_json: "{}",
          state: "pending",
          created_at: at,
          updated_at: at,
          ...overrides,
        })}`;
      yield* occurrence("first");
      // The same trigger of the same incarnation is the same operation.
      assert.isTrue(Exit.isFailure(yield* Effect.exit(occurrence("again"))));
      // A request key names exactly one operation.
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            occurrence("other-trigger", { trigger_key: "x", request_key: "request:first" }),
          ),
        ),
      );
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(occurrence("bad-kind", { trigger_kind: "cron" }))),
      );
      // A recreated task is a new incarnation, with its own occurrences.
      yield* occurrence("recreated", { task_incarnation: "incarnation-2" });
      const rows = yield* sql<{ occurrence_id: string; revision: number }>`
        SELECT occurrence_id, revision FROM scheduled_task_occurrences ORDER BY occurrence_id`;
      assert.deepStrictEqual(rows, [
        { occurrence_id: "first", revision: 1 },
        { occurrence_id: "recreated", revision: 1 },
      ]);
    }),
  );
});
