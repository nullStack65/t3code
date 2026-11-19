// @effect-diagnostics nodeBuiltinImport:off -- Native boundary of the staged-update channel: one directory watch, one file digest and one detached relaunch shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { StagedRelaunchCommand } from "./stagedUpdate.ts";

export class StagedUpdateNativeError extends Schema.TaggedError<StagedUpdateNativeError>()(
  "StagedUpdateNativeError",
  {
    operation: Schema.Literals(["watch", "digest", "relaunch"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Staged update ${this.operation} failed.`;
  }
}

/** Watches a directory, so an atomic rename of the file inside it is seen. */
export const watchDirectory = (directory: string, onChange: (name: string | null) => void) =>
  Effect.acquireRelease(
    Effect.try({
      try: () =>
        NodeFS.watch(directory, { persistent: false }, (_event, name) => onChange(name ?? null)),
      catch: (cause) => new StagedUpdateNativeError({ operation: "watch", cause }),
    }),
    (watcher) => Effect.sync(() => watcher.close()),
  );

export const sha256OfFile = (file: string) =>
  Effect.callback<string, StagedUpdateNativeError>((resume) => {
    const hash = NodeCrypto.createHash("sha256");
    const stream = NodeFS.createReadStream(file);
    stream.on("error", (cause) =>
      resume(Effect.fail(new StagedUpdateNativeError({ operation: "digest", cause }))),
    );
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resume(Effect.succeed(hash.digest("hex"))));
    return Effect.sync(() => stream.destroy());
  });

/** Starts the relaunch shell outside this process tree; it outlives the app by design. */
export const spawnDetachedRelaunch = (relaunch: StagedRelaunchCommand) =>
  Effect.try({
    try: () => {
      NodeChildProcess.spawn(relaunch.command, [...relaunch.args], {
        detached: true,
        stdio: "ignore",
        env: relaunch.env,
      }).unref();
    },
    catch: (cause) => new StagedUpdateNativeError({ operation: "relaunch", cause }),
  });
