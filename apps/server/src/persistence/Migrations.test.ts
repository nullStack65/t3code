import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Ref from "effect/Ref";
import * as Logger from "effect/Logger";
import * as Console from "effect/Console";
import * as NodeUtil from "node:util";
import type { DatabaseMigrationProgress as Progress } from "@t3tools/contracts";
import {
  databaseMigrationProgress,
  DATABASE_MIGRATION_PROGRESS_MESSAGE,
} from "@t3tools/shared/databaseMigrationLog";
import * as DatabaseMigrationProgress from "./DatabaseMigrationProgress.ts";

import { migrationManifest, runMigrations, UPSTREAM_MIGRATION_ID_OFFSET } from "./Migrations.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= 55);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "55_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 54, then rechecks it without a write lock", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      const current = yield* Ref.make<Progress | null>(null);
      const steps: Array<Progress | null> = [];
      const loggedSteps: Array<Progress | null> = [];
      let output = "";
      const pretty = Logger.consolePretty({ mode: "tty", colors: false });
      const logger = Logger.make((options) => {
        pretty.log(options);
        if (String(options.message).startsWith(DATABASE_MIGRATION_PROGRESS_MESSAGE)) {
          steps.push(Ref.getUnsafe(current));
          loggedSteps.push(databaseMigrationProgress(output.slice(-4_000)));
        }
      });
      assert.deepStrictEqual(
        yield* runMigrations().pipe(
          Effect.provideService(DatabaseMigrationProgress.DatabaseMigrationProgress, { current }),
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          Effect.provideService(Console.Console, {
            ...globalThis.console,
            log: (...args) => {
              output += `${NodeUtil.format(...args)}\n`;
            },
          }),
        ),
        v2Migrations,
      );
      assert.deepStrictEqual(
        steps,
        v2Migrations.map((_, index) => ({ current: index + 1, total: v2Migrations.length })),
      );
      assert.deepStrictEqual(loggedSteps, steps);
      assert.isNull(yield* Ref.get(current));
      assert.deepStrictEqual(
        yield* runMigrations().pipe(
          Effect.provideService(DatabaseMigrationProgress.DatabaseMigrationProgress, { current }),
        ),
        [],
      );
      assert.isNull(yield* Ref.get(current));
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);

      // query_only rejects BEGIN IMMEDIATE, which CLI startup would otherwise take on the live database.
      yield* sql`PRAGMA query_only = ON`;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("drops the unused correlation index and keeps correlation values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-1', 'thread', 'thread-1', 0, 'thread.created', '2026-01-01T00:00:00.000Z',
          'command-1', NULL, 'correlation-1', 'client', '{}', '{}'
        )
      `;

      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_events' AND sql IS NOT NULL
      `;
      const indexNames = indexes.map((row) => row.name);
      assert.notInclude(indexNames, "idx_orch_events_correlation_id");
      for (const kept of [
        "idx_orch_events_stream_version",
        "idx_orch_events_stream_sequence",
        "idx_orch_events_command_id",
        "idx_orchestration_events_agent_stream_sequence",
      ]) {
        assert.include(indexNames, kept);
      }
      const events = yield* sql<{ readonly correlation_id: string | null }>`
        SELECT correlation_id FROM orchestration_events WHERE event_id = 'event-1'
      `;
      assert.deepStrictEqual(events, [{ correlation_id: "correlation-1" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "56_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "57_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps the migrations that finished before a later one failed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 81 });
      yield* sql`CREATE TABLE orchestration_v2_projection_turn_item_counts (thread_id TEXT)`;

      const current = yield* Ref.make<Progress | null>(null);
      const exit = yield* Effect.exit(
        runMigrations().pipe(
          Effect.provideService(DatabaseMigrationProgress.DatabaseMigrationProgress, { current }),
        ),
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.isNull(yield* Ref.get(current));
      assert.deepStrictEqual(
        yield* history,
        migrationManifest.filter(([id]) => id <= 84),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("reapplies peer link migrations whose ledger rows are missing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 72 });
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id BETWEEN 70 AND 72`;

      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id >= 70),
      );
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// The fork keeps its own ledger ids 97 to 102 and numbers upstream's later migrations above them,
// so a file's number is its id, or its id plus the offset. Its name is the same either way.
it.effect("registers every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "Migrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [[Number(match[1]), match[2]!] as const] : [];
    });
    const registered = files.map(([fileId, name]) => {
      const entries = migrationManifest.filter(
        ([id, entryName]) =>
          entryName === name && (id === fileId || id === fileId + UPSTREAM_MIGRATION_ID_OFFSET),
      );
      assert.strictEqual(entries.length, 1, `${fileId}_${name} registers exactly once`);
      return entries[0]!;
    });
    assert.deepStrictEqual(
      registered.toSorted(([a], [b]) => a - b),
      migrationManifest,
    );
    assert.strictEqual(
      new Set(migrationManifest.map(([id]) => id)).size,
      migrationManifest.length,
      "every ledger id is used once",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

// Deployed fork databases record the fork's own migrations at ids 97 to 102, so those ids never
// move. Upstream numbered its own 97 to 116 differently; a database it wrote is a different
// history and must be refused, not skipped past.
describe("the fork's migration ledger", () => {
  const forkIds = [97, 98, 99, 100, 101, 102] as const;
  const upstreamLater = migrationManifest.filter(([id]) => id > 102);
  const columns = (table: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM pragma_table_info(${table})`;
      return rows.map((row) => row.name);
    });
  const tables = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `;
    return new Set(rows.map((row) => row.name));
  });

  it("keeps the fork's ids and numbers upstream's later migrations above them", () => {
    assert.deepStrictEqual(
      migrationManifest
        .filter(([id]) => id >= 97 && id <= 102)
        .map(([id, name]) => `${id}_${name}`),
      [
        "97_AuthSessionFounder",
        "98_FounderEnrollmentBindings",
        "99_FounderEnrollmentCorrections",
        "100_MessagesLatestVisibleIndex",
        "101_EventSubscriptions",
        "102_ScheduledTaskOccurrences",
      ],
    );
    assert.strictEqual(upstreamLater[0]?.[0], 97 + UPSTREAM_MIGRATION_ID_OFFSET);
    assert.strictEqual(upstreamLater[0]?.[1], "IssueTrackerBindings");
    // Upstream's order and gaps are kept, only shifted.
    for (const [index, [id]] of upstreamLater.entries()) {
      assert.strictEqual(id, 97 + UPSTREAM_MIGRATION_ID_OFFSET + index);
    }
  });

  it.effect("installs a fresh database with both histories, in ledger order", () =>
    Effect.gen(function* () {
      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, migrationManifest);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.include(yield* columns("auth_sessions"), "founder");
      const present = yield* tables;
      assert.isTrue(present.has("scheduled_task_occurrences"), "the fork's last migration ran");
      assert.isTrue(present.has("issue_tracker_bindings"), "upstream's first later one ran");
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each(forkIds)(
    "upgrades a fork database recorded at %s, applying only what it lacks",
    (recordedThrough) =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: recordedThrough });
        const before = yield* history;
        assert.strictEqual(before.at(-1)?.[0], recordedThrough);
        assert.isFalse((yield* tables).has("issue_tracker_bindings"));

        const executed = yield* runMigrations();

        assert.deepStrictEqual(
          executed,
          migrationManifest.filter(([id]) => id > recordedThrough),
        );
        // The recorded ids are untouched and nothing was renumbered.
        assert.deepStrictEqual(yield* history, migrationManifest);
        assert.deepStrictEqual(
          (yield* history).filter(([id]) => id <= recordedThrough),
          before,
        );
        assert.isTrue((yield* tables).has("issue_tracker_bindings"));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses a database a plain upstream build wrote", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 96 });
      // What upstream records: its own migrations at ids 97 to 116, under their own names.
      for (const [id, name] of upstreamLater) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${id - UPSTREAM_MIGRATION_ID_OFFSET}, ${name})
        `;
      }
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "97_AuthSessionFounder (recorded: IssueTrackerBindings)");
      assert.deepStrictEqual(yield* history, before);
      assert.isFalse((yield* columns("auth_sessions")).includes("founder"));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
