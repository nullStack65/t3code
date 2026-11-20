import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { SHOW_FILE_MAX_PATH_LENGTH, SHOW_FILE_TOOL_NAME } from "@t3tools/shared/showFile";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ShowFileTool = Tool.make(SHOW_FILE_TOOL_NAME, {
  description:
    "Show a file to the user in the file viewer. Pass its path. Returns only the path, byte size, and media type. Does not read the file, so its contents stay out of your context. Do not read or quote the file to show it.",
  parameters: Schema.Struct({
    path: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(SHOW_FILE_MAX_PATH_LENGTH),
    ).annotate({
      description: "Absolute path, ~/ path, or a path in this thread's workspace.",
    }),
    line: Schema.optional(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(1_000_000),
      ).annotate({
        description: "1-based line to reveal. Omit to open the start of the file.",
      }),
    ),
  }),
  success: Schema.Struct({
    path: Schema.String,
    byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    mediaType: Schema.String,
    line: Schema.optional(Schema.Int),
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    FileSystem.FileSystem,
    Path.Path,
    ServerConfig.ServerConfig,
  ],
})
  .annotate(Tool.Title, "Show a file")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const ShowFileToolkit = Toolkit.make(ShowFileTool);
