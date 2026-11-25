import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { REDIRECT_LEDGER_ENV } from "../RetiredThreadRedirect.ts";

const decodeLine = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

export interface TestRedirectLedger {
  readonly path: string;
  /** Every record appended so far; empty while the file does not exist. */
  readonly records: Effect.Effect<
    ReadonlyArray<Record<string, unknown>>,
    PlatformError | Schema.SchemaError
  >;
  /** The ledger file's permission bits. */
  readonly mode: Effect.Effect<number, PlatformError>;
}

/**
 * Runs `body` with the redirect ledger pointed at a file in a fresh temporary directory, which is
 * removed afterwards. `blocked` puts the path under a regular file, so every append fails.
 */
export const withRedirectLedger = <A, E, R>(
  body: (ledger: TestRedirectLedger) => Effect.Effect<A, E, R>,
  options: { readonly blocked?: boolean } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-redirect-ledger-" });
      let file = path.join(dir, "redirects.jsonl");
      if (options.blocked === true) {
        const blocker = path.join(dir, "blocker");
        yield* fs.writeFileString(blocker, "");
        file = path.join(blocker, "nested", "redirects.jsonl");
      }
      const ledger: TestRedirectLedger = {
        path: file,
        records: Effect.gen(function* () {
          if (!(yield* fs.exists(file))) return [];
          const text = yield* fs.readFileString(file);
          return yield* Effect.forEach(
            text.split("\n").filter((line) => line.length > 0),
            (line) => decodeLine(line),
          );
        }),
        mode: fs.stat(file).pipe(Effect.map((info) => info.mode & 0o777)),
      };
      return yield* body(ledger).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ [REDIRECT_LEDGER_ENV]: file })),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));
