// @effect-diagnostics nodeBuiltinImport:off - synthetic SQLite fixtures only.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { migrationManifest } from "./Migrations.ts";
import { admitProtocol2Database } from "./Protocol2DatabaseAdmission.ts";
import * as SqlitePersistence from "./Sqlite.ts";

function seed(path: string, rows: ReadonlyArray<readonly [number, string]>) {
  const db = new NodeSqlite.DatabaseSync(path);
  try {
    db.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)");
    const insert = db.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
    for (const [id, name] of rows) insert.run(id, name);
  } finally {
    db.close();
  }
}

it.effect.each(["newer", "collision"] as const)(
  "refuses a %s schema before the native writer changes the file",
  (kind) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "clo866-v2-schema-" });
      const file = path.join(directory, "statev2.sqlite");
      seed(file, kind === "newer" ? [[900, "FutureSchema"]] : [[57, "ThreadInbox"]]);
      const before = NodeFS.readFileSync(file);
      const result = yield* Effect.exit(
        Layer.build(SqlitePersistence.layerFromPath(file)).pipe(Effect.scoped),
      );
      assert.isTrue(Exit.isFailure(result));
      assert.include(String(result), "Protocol2DatabaseCompatibilityError");
      assert.deepEqual(NodeFS.readFileSync(file), before);
      assert.isFalse(NodeFS.existsSync(`${file}-wal`));
      assert.isFalse(NodeFS.existsSync(`${file}-shm`));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("accepts matching schema read-only and refuses implicit upgrades and imports", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "clo866-v2-exact-" });
    const current = path.join(directory, "current.sqlite");
    seed(current, migrationManifest);
    const before = NodeFS.readFileSync(current);
    yield* admitProtocol2Database(current, true);
    assert.deepEqual(NodeFS.readFileSync(current), before);
    const partial = path.join(directory, "partial.sqlite");
    seed(partial, migrationManifest.slice(0, 54));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(admitProtocol2Database(partial, true))));
    const fresh = path.join(directory, "statev2.sqlite");
    yield* admitProtocol2Database(fresh, true);
    assert.isFalse(NodeFS.existsSync(fresh));
    const legacy = path.join(directory, "state.sqlite");
    seed(legacy, [[1, "OrchestrationEvents"]]);
    const legacyBefore = NodeFS.readFileSync(legacy);
    const refused = yield* Effect.exit(admitProtocol2Database(fresh, true));
    assert.isTrue(Exit.isFailure(refused));
    assert.include(String(refused), "separately approved import");
    assert.isFalse(NodeFS.existsSync(fresh));
    assert.deepEqual(NodeFS.readFileSync(legacy), legacyBefore);
  }).pipe(Effect.provide(NodeServices.layer)),
);
