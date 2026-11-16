// @effect-diagnostics nodeBuiltinImport:off - startup preflight must precede opening a writer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { migrationManifest } from "./Migrations.ts";
import { recordedMigrations } from "./databaseMigrationHead.ts";

export class Protocol2DatabaseCompatibilityError extends Schema.TaggedError<Protocol2DatabaseCompatibilityError>()(
  "Protocol2DatabaseCompatibilityError",
  { databasePath: Schema.String, detail: Schema.String },
) {
  override get message() {
    return `Refusing this protocol-2 candidate at ${this.databasePath}: ${this.detail}. No database migration or import was attempted. Use the qualified build for this database.`;
  }
}

/** This port is qualified for an existing matching V2 schema or fresh synthetic
 * state. It must not invoke upstream's V1 copy/import path or upgrade a host as
 * a side effect of evaluating founder ACLs. Never infer compatibility from a
 * package version alone; compare every recorded migration's identity.
 */
export const admitProtocol2Database = Effect.fn("admitProtocol2Database")(function* (
  databasePath: string,
  requireCurrentSchema = false,
) {
  const refuse = (detail: string) =>
    new Protocol2DatabaseCompatibilityError({ databasePath, detail });
  if (!NodeFS.existsSync(databasePath)) {
    if (
      requireCurrentSchema &&
      NodeFS.existsSync(NodePath.join(NodePath.dirname(databasePath), "state.sqlite"))
    ) return yield* refuse("legacy state requires a separately approved import");
    return;
  }
  const recorded = recordedMigrations(databasePath);
  if (recorded === null) return yield* refuse("migration history cannot be read");
  const expected = new Map<number, string>(migrationManifest);
  const seen = new Set<number>();
  for (const row of recorded) {
    if (seen.has(row.id) || expected.get(row.id) !== row.name)
      return yield* refuse(`unrecognized migration ${row.id}:${row.name}`);
    seen.add(row.id);
  }
  if (requireCurrentSchema && recorded.length !== migrationManifest.length)
    return yield* refuse("schema does not exactly match this candidate");
});
