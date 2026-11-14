import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadRoutingToolkitHandlersLive } from "./handlers.ts";
import { ThreadRoutingToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread-1");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["pull-requests"]),
  issuedAt: 1,
});

function makeThread(patch: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...patch,
  };
}

const makeHarness = Effect.fn(function* (
  options: { readonly thread?: OrchestrationThreadShell | null } = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const thread = options.thread === undefined ? makeThread() : options.thread;
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      return { sequence: 1 };
    });
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(
          thread !== null && threadId === thread.id ? Option.some(thread) : Option.none(),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* ThreadRoutingToolkit.pipe(
    Effect.provide(ThreadRoutingToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = (params: Parameters<typeof toolkit.handle<"set_thread_routing">>[1]) =>
    toolkit.handle("set_thread_routing", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) =>
          chunk.at(-1)!.result as Tool.Success<
            (typeof ThreadRoutingToolkit.tools)["set_thread_routing"]
          >,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation()),
      Effect.provide(dependencies),
    );
  return { commands, call };
});

describe("thread routing toolkit", () => {
  it.effect("tags the calling thread and leaves omitted fields alone", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread({ owner: "Jeff", startedBy: "Lead" }),
      });
      const result = yield* harness.call({ threadType: "needs-human" });
      expect(result).toEqual({
        threadId: THREAD_ID,
        owner: "Jeff",
        threadType: "needs-human",
        startedBy: "Lead",
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.meta.update",
          threadId: THREAD_ID,
          threadType: "needs-human",
        },
      ]);
      expect((yield* Ref.get(harness.commands))[0]).not.toHaveProperty("owner");
    }),
  );

  it.effect("rejects a call that changes nothing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.call({}).pipe(Effect.flip);
      expect(error._tag).toBe("ThreadRoutingInvalidError");
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );
});
