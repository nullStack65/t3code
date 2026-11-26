import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../McpToolAccess.ts";
import { MessageToolkit } from "./tools.ts";

const handlers = {
  send_to_user: McpToolAccess.actsAsCaller((input) =>
    Effect.succeed({
      sentMessage: input.message,
      message: "Shown to the user. Don't repeat it.",
    }),
  ),
  silent_ack: McpToolAccess.actsAsCaller(() =>
    Effect.succeed({
      acknowledged: true as const,
      message: "Acknowledged silently; kept folded.",
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof MessageToolkit.tools>;

export const layer = McpToolAccess.toLayer(MessageToolkit, handlers);
