import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ShowFileHandlers from "./handlers.ts";
import { ShowFileToolkit } from "./tools.ts";

const SENTINEL = "SECRET_FILE_BYTES_9f3a";
const environmentId = EnvironmentId.make("environment:show-file");
const threadId = ThreadId.make("thread:show-file");

it.effect("returns path, size, and type and does not put file bytes in the result", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-show-file-" });
    const filePath = path.join(directory, "answers.md");
    yield* fileSystem.writeFileString(filePath, SENTINEL);
    const layer = McpToolAccess.HandlersLayer.layer(ShowFileHandlers.layer).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(McpInvocationContext.McpInvocationContext, {
            environmentId,
            requestNamespace: "provider:show-file",
            thread: {
              threadId,
              providerSessionId: "provider:show-file",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
            client: undefined,
            capabilities: new Set(["orchestration" as const]),
            issuedAt: 0,
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({ ...liveThreadShell(threadId), worktreePath: directory }),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          ServerConfig.layerTest(directory, { prefix: "t3-show-file-config-" }),
        ),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    const call = (params: { readonly path: string; readonly line?: number }) =>
      Effect.gen(function* () {
        const toolkit = yield* ShowFileToolkit;
        const parts = yield* toolkit
          .handle("show_file", params)
          .pipe(Stream.unwrap, Stream.runCollect);
        return parts.at(-1)?.result;
      }).pipe(Effect.provide(layer));

    const shown = yield* call({ path: filePath, line: 4 });
    expect(shown).toEqual({
      path: filePath,
      byteSize: SENTINEL.length,
      mediaType: "text/markdown",
      line: 4,
      message: "Shown in the file viewer. Do not read or quote the file.",
    });
    expect(JSON.stringify(shown)).not.toContain(SENTINEL);
    expect(Object.keys(shown as object).sort()).toEqual([
      "byteSize",
      "line",
      "mediaType",
      "message",
      "path",
    ]);

    const relative = yield* call({ path: "answers.md" });
    expect(relative).toMatchObject({
      path: filePath,
      byteSize: SENTINEL.length,
      mediaType: "text/markdown",
    });
    expect(JSON.stringify(relative)).not.toContain(SENTINEL);

    const missing = yield* call({ path: path.join(directory, "missing.md") });
    expect(missing).toMatchObject({ code: "invalid_request", message: "File not found." });
    expect(JSON.stringify(missing)).not.toContain(SENTINEL);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
