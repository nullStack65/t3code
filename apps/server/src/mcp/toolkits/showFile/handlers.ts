import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { isNetworkPath } from "@t3tools/shared/path";
import { mediaTypeForPath } from "@t3tools/shared/showFile";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeIsServerInternalPath } from "../../../auth/serverInternalPaths.ts";
import { expandHomePath } from "../../../os-jank.ts";
import { threadWorkspaceRoot } from "../../../project/threadWorkspaceRoot.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ShowFileToolkit } from "./tools.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const showFile = Effect.fn("ShowFile.stat")(function* (input: {
  readonly path: string;
  readonly line?: number | undefined;
}) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const expanded = yield* expandHomePath(input.path);
  const workspaceRoot =
    scope.thread === undefined ? undefined : yield* threadWorkspaceRoot(scope.thread.threadId);
  if (!path.isAbsolute(expanded) && workspaceRoot === undefined) {
    return yield* invalid("Pass an absolute path or a path in this thread's workspace.");
  }
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(workspaceRoot ?? expanded, expanded);
  if (isNetworkPath(resolved)) {
    return yield* invalid("That path cannot be shown.");
  }
  const stat = yield* fileSystem
    .stat(resolved)
    .pipe(Effect.mapError(() => invalid("File not found.")));
  if (stat.type !== "File") {
    return yield* invalid("Not a file.");
  }
  const isServerInternalPath = yield* makeIsServerInternalPath;
  if (yield* isServerInternalPath(resolved)) {
    return yield* invalid("That file cannot be shown.");
  }
  const byteSize = Number(stat.size);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
    return yield* invalid("That file cannot be shown.");
  }
  return {
    showFile: {
      path: resolved,
      byteSize,
      mediaType: mediaTypeForPath(resolved),
      ...(input.line === undefined ? {} : { line: input.line }),
    },
    message: "Shown in the file viewer. Do not read or quote the file.",
  };
});

const handlers = {
  show_file: McpToolAccess.actsAsCaller((input) => showFile(input)),
} satisfies McpToolAccess.Handlers<typeof ShowFileToolkit.tools>;

export const layer = McpToolAccess.toLayer(ShowFileToolkit, handlers);
