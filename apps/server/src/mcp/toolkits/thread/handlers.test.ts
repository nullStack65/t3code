import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ThreadHandlers from "./handlers.ts";
import { ThreadToolkit } from "./tools.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const threadId = ThreadId.make("thread:configure-model");
const provider = {
  instanceId: claude,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  status: "ready",
  version: "test",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [
    {
      slug: "claude-opus",
      name: "Opus",
      aliases: ["Opus"],
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
} as ServerProvider;

it.effect("thread configure refuses a Grok model on claudeAgent and accepts a served model", () =>
  Effect.gen(function* () {
    const dispatched: OrchestrationV2ServerCommand[] = [];
    const shell = {
      id: threadId,
      projectId: ProjectId.make("project:configure-model"),
      providerInstanceId: claude,
      modelSelection: { instanceId: claude, model: "claude-opus" },
      runtimeMode: "full-access",
      interactionMode: "default",
      deletedAt: null,
    };
    const dependencies = Layer.mergeAll(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([provider]),
      }),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "client:configure-model",
        thread: undefined,
        client: { sessionId: "session-1", label: "Codex", access: "full-access" },
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(shell as never),
        getProjectThreadRecords: () => Effect.succeed({ thread: shell } as never),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length, storedEvents: [] } as never;
          }),
      }),
      NodeCrypto.layer,
    );
    const toolkit = yield* ThreadToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const configure = (model: string) =>
      toolkit
        .handle("t3_thread_configure", {
          threadId,
          modelSelection: { instanceId: claude, model },
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((result) => result.at(-1)?.result),
          Effect.provide(dependencies),
        );

    const refused = yield* configure("grok/grok-4.7");
    expect(refused).toMatchObject({
      code: "model_unavailable",
      message: expect.stringContaining("claude-opus"),
    });
    expect(refused).toMatchObject({
      message: expect.stringContaining(
        "Model grok/grok-4.7 is not advertised by provider claudeAgent.",
      ),
    });
    expect(dispatched).toHaveLength(0);

    expect(yield* configure("Opus")).toMatchObject({ sequence: 1 });
    expect(dispatched).toMatchObject([
      {
        type: "thread.model-selection.set",
        modelSelection: { instanceId: claude, model: "Opus" },
      },
    ]);
  }),
);
