import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assertMigrationCompatibility, runMigrations } from "./Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "migration compatibility fence",
  (it) => {
    it.effect(
      "allows a recognized fresh database and rejects protocol-2/newer history without schema changes",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 1 });
          yield* assertMigrationCompatibility;
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (80, 'Protocol2Synthetic')`;
          const before = yield* sql`SELECT name, sql FROM sqlite_schema ORDER BY name`;
          const result = yield* Effect.result(runMigrations());
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") assert.equal(result.failure._tag, "MigrationError");
          assert.deepEqual(yield* sql`SELECT name, sql FROM sqlite_schema ORDER BY name`, before);
          assert.deepEqual(
            yield* sql`SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id`,
            [{ migration_id: 1 }, { migration_id: 80 }],
          );
        }),
    );
  },
);
it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("foreign migration lineage", (it) => {
  it.effect("rejects a colliding migration ID instead of treating it as this fork", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 1 });
      yield* sql`UPDATE effect_sql_migrations SET name = 'ForeignSynthetic' WHERE migration_id = 1`;
      const result = yield* Effect.result(assertMigrationCompatibility);
      assert.equal(result._tag, "Failure");
      assert.deepEqual(yield* sql`SELECT name FROM effect_sql_migrations`, [
        { name: "ForeignSynthetic" },
      ]);
    }),
  );
});

it.effect(
  "refuses a newer synthetic file before changing its journal mode or opening it for writes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "clo866-downgrade-" });
      const filename = path.join(directory, "synthetic.sqlite");
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)`;
        yield* sql`INSERT INTO effect_sql_migrations VALUES (80, 'Protocol2Synthetic')`;
        yield* sql`CREATE TABLE synthetic_history (event TEXT)`;
        yield* sql`INSERT INTO synthetic_history VALUES ('preserve')`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      const result = yield* Effect.result(Layer.build(makeSqlitePersistenceLive(filename)));
      assert.equal(result._tag, "Failure");
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`PRAGMA journal_mode`, [{ journal_mode: "delete" }]);
        assert.deepEqual(yield* sql`SELECT event FROM synthetic_history`, [{ event: "preserve" }]);
        assert.deepEqual(yield* sql`SELECT migration_id FROM effect_sql_migrations`, [
          { migration_id: 80 },
        ]);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename, readonly: true })));
      assert.equal(yield* fs.exists(filename + "-wal"), false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
