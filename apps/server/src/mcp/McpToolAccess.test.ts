import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as Feedback from "../feedback/FeedbackService.ts";
import * as FeedbackHandlers from "./toolkits/feedback/handlers.ts";
import { FeedbackToolkit } from "./toolkits/feedback/tools.ts";
import * as OrchestratorHandlers from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";

const supervisedThreadId = ThreadId.make("thread:supervised");
const planThreadId = ThreadId.make("thread:plan");
const fullAccessThreadId = ThreadId.make("thread:full-access");
const endedThreadId = ThreadId.make("thread:ended");
const backgroundThreadId = ThreadId.make("thread:background");
const oldProviderThreadId = ThreadId.make("thread:old-provider-background");
const archivedThreadId = ThreadId.make("thread:archived-background");
const unknownOwnerThreadId = ThreadId.make("thread:unknown-background-owner");

const backgroundShell = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) => ({
  ...liveThreadShell(threadId, { activeRunId: null }),
  pendingBackgroundTasks: [
    { taskId: "task:background", kind: "subagent" as const, providerInstanceId },
  ],
});

const shells = new Map([
  [supervisedThreadId, liveThreadShell(supervisedThreadId, { runtimeMode: "approval-required" })],
  [
    planThreadId,
    liveThreadShell(planThreadId, { runtimeMode: "approval-required", interactionMode: "plan" }),
  ],
  [fullAccessThreadId, liveThreadShell(fullAccessThreadId)],
  [endedThreadId, liveThreadShell(endedThreadId, { activeRunId: null })],
  [backgroundThreadId, backgroundShell(backgroundThreadId, ProviderInstanceId.make("codex"))],
  [oldProviderThreadId, backgroundShell(oldProviderThreadId, ProviderInstanceId.make("claude"))],
  [
    archivedThreadId,
    {
      ...backgroundShell(archivedThreadId, ProviderInstanceId.make("codex")),
      archivedAt: liveThreadShell(archivedThreadId).updatedAt,
    },
  ],
  [
    unknownOwnerThreadId,
    {
      ...liveThreadShell(unknownOwnerThreadId, { activeRunId: null }),
      pendingBackgroundTasks: [{ taskId: "task:unknown", kind: "subagent" as const }],
    },
  ],
]);

const threadCaller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const clientCaller = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const probe = {
  success: Schema.Struct({ ran: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
const ProbeToolkit = Toolkit.make(
  Tool.make("reads", probe),
  Tool.make("reads_as_caller", probe).annotate(
    McpSchema.EnabledWhen,
    McpInvocationContext.hiddenFromOutsideClients,
  ),
  Tool.make("acts_as_caller", probe).annotate(
    McpSchema.EnabledWhen,
    McpInvocationContext.hiddenFromOutsideClients,
  ),
  Tool.make("writes", probe),
  Tool.make("writes_with_capability", probe),
  Tool.make("writes_threads", {
    ...probe,
    parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  }),
  Tool.make("starts_threads", {
    ...probe,
    parameters: Schema.Struct({
      runtimeMode: Schema.optional(RuntimeMode),
      interactionMode: Schema.optional(ProviderInteractionMode),
    }),
  }),
  Tool.make("writes_environment", probe),
  Tool.make("writes_owner_work", probe),
);
const ran = Effect.succeed({ ran: "ran" });
const probeHandlers: McpToolAccess.Handlers<typeof ProbeToolkit.tools> = {
  reads: McpToolAccess.reads(() => ran),
  reads_as_caller: McpToolAccess.readsAsCaller(() => ran),
  acts_as_caller: McpToolAccess.actsAsCaller(() => ran),
  writes: McpToolAccess.writes(() => ran),
  writes_with_capability: McpToolAccess.writesWithCapability(() => ran),
  writes_threads: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    () => ran,
  ),
  starts_threads: McpToolAccess.startsThreads(
    (input) => input,
    (_, modes) => Effect.succeed({ ran: `${modes.runtimeMode}/${modes.interactionMode}` }),
    "stamped",
  ),
  writes_environment: McpToolAccess.writesEnvironment(() => ran),
  writes_owner_work: McpToolAccess.writesOwnerWork("drive owner work", () => ran),
};
const layerProbeHandlers = McpToolAccess.toLayer(ProbeToolkit, probeHandlers);

const unchecked = () => ran;

// `@ts-expect-error` fails the build if one ever compiles. Never called.
export const refusedAtCompileTime = () => {
  McpToolAccess.toLayer(ProbeToolkit, {
    ...probeHandlers,
    // @ts-expect-error a handler that skips its declaration
    reads: unchecked,
  });
  McpToolAccess.toLayer(ProbeToolkit, {
    ...probeHandlers,
    // @ts-expect-error a declaration's fields copied onto an unchecked handler
    reads: Object.assign(
      unchecked,
      McpToolAccess.reads(() => ran),
    ),
  });
  // @ts-expect-error a declaration built outside McpToolAccess
  McpToolAccess.Declaration.make(unchecked);
  // @ts-expect-error a declaration constructed directly
  new McpToolAccess.Declaration(unchecked); // oxlint-disable-line eslint/no-new -- This type-contract test checks direct construction.
  // @ts-expect-error a handlers layer built outside McpToolAccess
  McpToolAccess.HandlersLayer.make(Layer.empty);
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  McpHttpServer.toolkitRegistration(
    ProbeToolkit,
    // @ts-expect-error a handlers layer that skipped `McpToolAccess.toLayer`
    ProbeToolkit.toLayer({
      reads: unchecked,
      reads_as_caller: unchecked,
      acts_as_caller: unchecked,
      writes: unchecked,
      writes_with_capability: unchecked,
      writes_threads: unchecked,
      starts_threads: unchecked,
      writes_environment: unchecked,
      writes_owner_work: unchecked,
    }),
  );
};

const probeServer = (threads: Layer.Layer<ThreadManagement.ThreadManagementService>) =>
  McpHttpServer.toolkitRegistration(ProbeToolkit, layerProbeHandlers).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(threads),
  );

const decodeOutcome = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([Schema.Struct({ ran: Schema.String }), Schema.Struct({ code: Schema.String })]),
  ),
);

const call = (
  tool: string,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown> = {},
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: tool, arguments: args })),
    Effect.flatMap(({ content }) =>
      decodeOutcome(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.map((outcome) => ("code" in outcome ? outcome.code : outcome.ran)),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const supervised = threadCaller(supervisedThreadId);
const plan = threadCaller(planThreadId);
const fullAccess = threadCaller(fullAccessThreadId);
const ended = threadCaller(endedThreadId);
const background = threadCaller(backgroundThreadId);
const oldProviderBackground = threadCaller(oldProviderThreadId);
const archivedBackground = threadCaller(archivedThreadId);
const unknownOwnerBackground = threadCaller(unknownOwnerThreadId);
const mismatchedProvider = {
  ...background,
  thread: { ...background.thread!, providerInstanceId: ProviderInstanceId.make("claude") },
};
const supervisedClient = clientCaller("approval-required");
const fullAccessClient = clientCaller("full-access");
const readOnlyClient = clientCaller("read-only");
const linkedClient: McpInvocationContext.McpInvocationScope = {
  ...supervisedClient,
  client: { ...supervisedClient.client!, linked: true },
};
// A full-access link's agents can do anything this environment's user can.
const fullAccessLinkedClient: McpInvocationContext.McpInvocationScope = {
  ...fullAccessClient,
  client: { ...fullAccessClient.client!, linked: true },
};
// An administrator's ceiling narrows every client to it.
const atCeilingClient: McpInvocationContext.McpInvocationScope = {
  ...fullAccessClient,
  runtimeModeCeiling: "auto",
  client: {
    ...fullAccessClient.client!,
    narrowedTo: { runtimeMode: "auto", interactionMode: "default" },
  },
};
const previewOnly = { ...fullAccess, capabilities: new Set(["preview"] as const) };

it.effect.each([
  ["reads", ended, {}, "ran"],
  ["reads", supervisedClient, {}, "ran"],
  ["reads", readOnlyClient, {}, "ran"],

  ["writes", readOnlyClient, {}, "capability_denied"],
  ["writes_threads", readOnlyClient, { threadId: supervisedThreadId }, "capability_denied"],
  ["starts_threads", readOnlyClient, {}, "capability_denied"],
  ["writes_environment", readOnlyClient, {}, "capability_denied"],

  ["reads_as_caller", ended, {}, "ran"],
  ["acts_as_caller", supervised, {}, "ran"],
  ["acts_as_caller", ended, {}, "parent_not_active"],
  ["acts_as_caller", background, {}, "ran"],
  ["acts_as_caller", oldProviderBackground, {}, "parent_not_active"],
  ["acts_as_caller", mismatchedProvider, {}, "parent_not_active"],
  ["acts_as_caller", archivedBackground, {}, "parent_not_active"],
  ["acts_as_caller", unknownOwnerBackground, {}, "parent_not_active"],

  ["writes", supervised, {}, "ran"],
  ["writes", ended, {}, "parent_not_active"],
  ["writes", background, {}, "ran"],
  ["writes", oldProviderBackground, {}, "parent_not_active"],
  ["writes", supervisedClient, {}, "ran"],
  ["writes", previewOnly, {}, "capability_denied"],
  ["writes_environment", previewOnly, {}, "capability_denied"],

  ["writes_with_capability", previewOnly, {}, "ran"],
  ["writes_with_capability", readOnlyClient, {}, "capability_denied"],
  ["writes_with_capability", ended, {}, "parent_not_active"],
  ["writes", linkedClient, {}, "capability_denied"],
  ["writes_with_capability", linkedClient, {}, "capability_denied"],
  ["writes", fullAccessLinkedClient, {}, "ran"],
  ["writes_with_capability", fullAccessLinkedClient, {}, "ran"],

  ["writes_threads", supervised, {}, "ran"],
  ["writes_threads", supervised, { threadId: planThreadId }, "ran"],
  [
    "writes_threads",
    supervised,
    { threadId: fullAccessThreadId },
    "runtime_mode_escalation_denied",
  ],
  ["writes_threads", plan, { threadId: supervisedThreadId }, "interaction_mode_escalation_denied"],
  ["writes_threads", fullAccess, { threadId: supervisedThreadId }, "ran"],
  ["writes_threads", ended, { threadId: supervisedThreadId }, "parent_not_active"],
  ["writes_threads", supervisedClient, { threadId: supervisedThreadId }, "ran"],
  [
    "writes_threads",
    supervisedClient,
    { threadId: fullAccessThreadId },
    "runtime_mode_escalation_denied",
  ],
  ["writes_threads", supervised, { threadId: "thread:missing" }, "ran"],

  ["starts_threads", supervised, {}, "approval-required/default"],
  ["starts_threads", supervised, { runtimeMode: "full-access" }, "runtime_mode_escalation_denied"],
  ["starts_threads", plan, {}, "approval-required/plan"],
  ["starts_threads", plan, { interactionMode: "default" }, "interaction_mode_escalation_denied"],
  ["starts_threads", fullAccess, { runtimeMode: "auto", interactionMode: "plan" }, "auto/plan"],
  ["starts_threads", ended, {}, "parent_not_active"],
  ["starts_threads", supervisedClient, {}, "approval-required/default"],
  ["starts_threads", supervisedClient, { runtimeMode: "auto" }, "runtime_mode_escalation_denied"],
  ["starts_threads", fullAccessClient, { runtimeMode: "full-access" }, "full-access/default"],

  ["writes_environment", fullAccess, {}, "ran"],
  ["writes_environment", supervised, {}, "capability_denied"],
  ["writes_environment", plan, {}, "capability_denied"],
  ["writes_environment", fullAccessClient, {}, "ran"],
  ["writes_environment", supervisedClient, {}, "capability_denied"],

  ["writes_owner_work", fullAccess, {}, "ran"],
  ["writes_owner_work", supervised, {}, "capability_denied"],
  ["writes_owner_work", plan, {}, "capability_denied"],
  ["writes_owner_work", ended, {}, "parent_not_active"],
  ["writes_owner_work", fullAccessClient, {}, "ran"],
  ["writes_owner_work", supervisedClient, {}, "capability_denied"],
  ["writes_owner_work", readOnlyClient, {}, "capability_denied"],
  ["writes_owner_work", linkedClient, {}, "capability_denied"],
  ["writes_owner_work", fullAccessLinkedClient, {}, "ran"],
  ["writes_owner_work", atCeilingClient, {}, "ran"],
  ["writes_environment", atCeilingClient, {}, "capability_denied"],
] as const)("%s from %o with %o: %s", ([tool, scope, args, expected]) =>
  call(tool, scope, args).pipe(
    Effect.map((outcome) => expect(outcome).toBe(expected)),
    Effect.provide(
      probeServer(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
        }),
      ),
    ),
  ),
);

it("refuses a declaration or handlers layer that only wears another's fields", () => {
  const copiedDeclaration = Object.assign(
    unchecked,
    McpToolAccess.reads(() => ran),
  );
  expect(() =>
    McpToolAccess.toLayer(ProbeToolkit, {
      ...probeHandlers,
      // @ts-expect-error a declaration's fields copied onto an unchecked handler
      reads: copiedDeclaration,
    }),
  ).toThrow(TypeError);
  const copiedLayer = Object.assign(Layer.empty, layerProbeHandlers);
  expect(() => McpToolAccess.HandlersLayer.layer(copiedLayer)).toThrow(TypeError);
});

it.effect("refuses a change when the calling thread cannot be read", () =>
  call("writes", supervised).pipe(
    Effect.map((outcome) => expect(outcome).toBe("orchestration_error")),
    Effect.provide(
      probeServer(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.fail(new OrchestratorProjectionError({ threadId, cause: "unreadable" })),
        }),
      ),
    ),
  ),
);

const box = EnvironmentId.make("environment-box");
const here = EnvironmentId.make("environment");

const questionToolMocks = Layer.mergeAll(
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
  }),
  Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
    requestSecret: () => Effect.succeed({ status: "timed_out" }),
  }),
  Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({
    update: (_scope, input) =>
      Effect.succeed({
        threadId: fullAccessThreadId,
        commandId: CommandId.make("command-update"),
        action: input.action,
        title: input.title ?? "Fixture",
        sequence: 1,
        titleRegeneration: null,
        linkedPullRequest: null,
        updatedAt: "2026-06-06T00:00:00.000Z",
      }),
  }),
  Layer.mock(Feedback.FeedbackService)({
    submit: () =>
      Effect.succeed({ status: "awaiting_approval" as const, note: "Fixture feedback" }),
  }),
  Layer.mock(PeerForwarding.PeerForwarding)({
    call: () => Effect.succeed({ ran: "forwarded" } as never),
  }),
  Layer.mock(PeerLinks.PeerLinks)({}),
  Layer.mock(PeerLinkRequests.PeerLinkRequests)({
    request: () => Effect.succeed({ status: "pending" as const } as never),
  }),
  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
);

const questionToolServer = Layer.mergeAll(
  McpHttpServer.toolkitRegistration(OrchestratorToolkit, OrchestratorHandlers.layer),
  McpHttpServer.toolkitRegistration(FeedbackToolkit, FeedbackHandlers.layer),
).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(questionToolMocks),
);

it.effect("keeps human questions out of delegated MCP calls, including forwarded decisions", () =>
  Effect.gen(function* () {
    const parentWithFeatures: McpInvocationContext.McpInvocationScope = {
      ...fullAccess,
      linkedEnvironments: true,
      agentFeedback: "on-request",
    };
    const child: McpInvocationContext.McpInvocationScope = {
      ...parentWithFeatures,
      thread: { ...parentWithFeatures.thread!, subagent: true },
    };
    const server = yield* McpServer.McpServer;
    const visible = (toolName: string, scope: McpInvocationContext.McpInvocationScope) =>
      Effect.sync(() => {
        const entry = server.tools.find(({ tool }) => tool.name === toolName)!;
        return Context.getOrUndefined(
          entry.annotations,
          McpSchema.EnabledWhen,
        )?.({
          protocolVersion: mcpClient.protocolVersion,
          capabilities: mcpClient.clientCapabilities,
        });
      }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scope));
    for (const toolName of ["request_secret", "t3_environment_link", "t3_feedback"] as const) {
      expect(yield* visible(toolName, parentWithFeatures)).toBe(true);
      expect(yield* visible(toolName, child)).toBe(false);
    }
  }).pipe(Effect.provide(questionToolServer)),
);

it.effect("rejects delegated questions at MCP execution before forwarding", () =>
  Effect.gen(function* () {
    const parentWithFeatures: McpInvocationContext.McpInvocationScope = {
      ...fullAccess,
      linkedEnvironments: true,
      agentFeedback: "on-request",
    };
    const child: McpInvocationContext.McpInvocationScope = {
      ...parentWithFeatures,
      thread: { ...parentWithFeatures.thread!, subagent: true },
    };
    const decision = {
      action: "request_decision",
      decision: { founder: "kameron", kind: "decision", question: "Synthetic question" },
    };
    const server = yield* McpServer.McpServer;
    const callAs = (scope: McpInvocationContext.McpInvocationScope, name: string, args: object) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
        );
    const secret = { label: "Fixture", reason: "Synthetic request" };
    const parentSecret = yield* callAs(parentWithFeatures, "request_secret", secret);
    expect(parentSecret.structuredContent).toMatchObject({ status: "timed_out" });
    const childSecret = yield* callAs(child, "request_secret", secret).pipe(Effect.exit);
    expect(Exit.isFailure(childSecret) || childSecret.value.isError).toBe(true);
    const childLink = yield* callAs(child, "t3_environment_link", { hint: "vps" }).pipe(
      Effect.exit,
    );
    expect(Exit.isFailure(childLink) || childLink.value.isError).toBe(true);
    const childFeedback = yield* callAs(child, "t3_feedback", {
      kind: "bug",
      subject: "general",
      expected: "ok",
      actual: "broken",
      workaround: "",
      userRequested: true,
    }).pipe(Effect.exit);
    expect(Exit.isFailure(childFeedback) || childFeedback.value.isError).toBe(true);
    expect(yield* call("t3_thread_update", child, decision)).toBe("capability_denied");
    expect(yield* call("t3_thread_update", child, { ...decision, environmentId: box })).toBe(
      "capability_denied",
    );
    for (const audience of ["kameron", "jeff", "shared"] as const) {
      const routeToFounder = {
        action: "route",
        inboxRouting: { audience, reason: "decision" },
      };
      expect(yield* call("t3_thread_update", child, routeToFounder)).toBe("capability_denied");
      expect(
        yield* call("t3_thread_update", child, { ...routeToFounder, environmentId: box }),
      ).toBe("capability_denied");
    }
    const routedAgentOnly = yield* callAs(child, "t3_thread_update", {
      action: "route",
      inboxRouting: { audience: "agent-only" },
    });
    expect(routedAgentOnly.structuredContent).toMatchObject({ action: "route" });
    const renamed = yield* callAs(child, "t3_thread_update", {
      action: "rename",
      title: "Fixture",
    });
    expect(renamed.structuredContent).toMatchObject({ action: "rename", title: "Fixture" });

    // Even if MCP discovery were bypassed, the underlying handlers still refuse subagents.
    const directOrchestrator = yield* OrchestratorToolkit.pipe(
      Effect.provide(
        Layer.mergeAll(
          McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer),
          questionToolMocks,
        ),
      ),
    );
    const directLink = yield* directOrchestrator
      .handle("t3_environment_link", { hint: "vps" })
      .pipe(
        Stream.unwrap,
        Stream.run(Sink.last()),
        Effect.flatMap(Effect.fromOption),
        Effect.provideService(McpInvocationContext.McpInvocationContext, child),
      );
    expect(directLink.result).toMatchObject({ code: "capability_denied" });
    const directFeedbackToolkit = yield* FeedbackToolkit.pipe(
      Effect.provide(
        Layer.mergeAll(
          McpToolAccess.HandlersLayer.layer(FeedbackHandlers.layer),
          questionToolMocks,
        ),
      ),
    );
    const directFeedback = yield* directFeedbackToolkit
      .handle("t3_feedback", {
        kind: "bug",
        subject: "general",
        expected: "ok",
        actual: "broken",
        workaround: "",
        userRequested: true,
        turns: 1,
      })
      .pipe(
        Stream.unwrap,
        Stream.run(Sink.last()),
        Effect.flatMap(Effect.fromOption),
        Effect.provideService(McpInvocationContext.McpInvocationContext, child),
      );
    expect(directFeedback.result).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.provide(questionToolServer)),
);

const linkedProbe = {
  ...probe,
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
  }),
};
const LinkedProbeToolkit = Toolkit.make(
  Tool.make("reads", linkedProbe),
  Tool.make("writes", linkedProbe),
  Tool.make("writes_with_capability", linkedProbe),
  Tool.make("writes_threads", linkedProbe),
  Tool.make("starts_threads", linkedProbe),
  Tool.make("writes_environment", linkedProbe),
);
/** Runs here, and tells whether `environmentId` reached the handler. */
const ranHere = <P extends object>(params: P) =>
  Effect.succeed({ ran: "environmentId" in params ? "saw environmentId" : "here" });

const linkedProbeServer = McpHttpServer.toolkitRegistration(
  LinkedProbeToolkit,
  McpToolAccess.toLayer(LinkedProbeToolkit, {
    reads: McpToolAccess.reads(ranHere),
    writes: McpToolAccess.writes(ranHere),
    writes_with_capability: McpToolAccess.writesWithCapability(ranHere),
    writes_threads: McpToolAccess.writesThreads((input) => [input.threadId], ranHere),
    starts_threads: McpToolAccess.startsThreads((input) => input, ranHere, "stamped"),
    writes_environment: McpToolAccess.writesEnvironment(ranHere),
  }),
).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
    }),
  ),
  // Stands in for the linked environment, answering with where the call went.
  Layer.provide(
    Layer.mock(PeerForwarding.PeerForwarding)({
      call: (_scope, tool, environmentId) =>
        Effect.succeed({ ran: `${tool.name} in ${environmentId}` } as never),
    }),
  ),
);

it.effect.each([
  ["reads", supervised, { environmentId: box }, "reads in environment-box"],
  ["reads", supervised, { environmentId: here }, "here"],
  ["reads", supervised, {}, "here"],

  // The caller is checked here before anything goes.
  ["writes", readOnlyClient, { environmentId: box }, "capability_denied"],
  ["writes", ended, { environmentId: box }, "parent_not_active"],
  ["writes", supervised, { environmentId: box }, "writes in environment-box"],
  ["writes_with_capability", readOnlyClient, { environmentId: box }, "capability_denied"],
  [
    "starts_threads",
    plan,
    { environmentId: box, interactionMode: "default" },
    "interaction_mode_escalation_denied",
  ],
  ["starts_threads", plan, { environmentId: box }, "starts_threads in environment-box"],
  ["writes_environment", supervised, { environmentId: box }, "capability_denied"],
  [
    "writes_environment",
    fullAccess,
    { environmentId: box },
    "writes_environment in environment-box",
  ],
  ["writes_environment", fullAccess, { environmentId: here }, "here"],

  // A thread id names a thread where the call runs, and is checked there.
  [
    "writes_threads",
    supervised,
    { environmentId: box, threadId: fullAccessThreadId },
    "writes_threads in environment-box",
  ],
  [
    "writes_threads",
    supervised,
    { environmentId: here, threadId: fullAccessThreadId },
    "runtime_mode_escalation_denied",
  ],
] as const)("a linked %s from %o with %o: %s", ([tool, scope, args, expected]) =>
  call(tool, scope, args).pipe(
    Effect.map((outcome) => expect(outcome).toBe(expected)),
    Effect.provide(linkedProbeServer),
  ),
);

it.effect("refuses a linked environment to a tool that acts as its calling thread", () =>
  Effect.gen(function* () {
    const CallerToolkit = Toolkit.make(
      Tool.make("acts_as_caller", linkedProbe).annotate(
        McpSchema.EnabledWhen,
        McpInvocationContext.hiddenFromOutsideClients,
      ),
    );
    const built = yield* Layer.build(
      McpToolAccess.HandlersLayer.layer(
        McpToolAccess.toLayer(CallerToolkit, {
          acts_as_caller: McpToolAccess.actsAsCaller(ranHere),
        }),
      ),
    ).pipe(Effect.scoped, Effect.exit);
    expect(Exit.isFailure(built) && Cause.hasDies(built.cause)).toBe(true);
  }),
);

// Discovery hides these tools. The handler must refuse on its own if that ever changes.
it.effect.each(["reads_as_caller", "acts_as_caller"] as const)(
  "%s refuses an outside client behind discovery",
  (tool) =>
    Effect.gen(function* () {
      const built = yield* ProbeToolkit;
      const { result } = yield* built
        .handle(tool, {})
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption));
      expect(result).toMatchObject({ code: "thread_credential_required" });
    }).pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(layerProbeHandlers)),
      Effect.provideService(McpInvocationContext.McpInvocationContext, fullAccessClient),
      Effect.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
    ),
);

it.effect("refuses to build a thread-bound tool that outside clients would be offered", () =>
  Effect.gen(function* () {
    const CallerToolkit = Toolkit.make(Tool.make("reads_as_caller", probe));
    const built = yield* Layer.build(
      McpToolAccess.HandlersLayer.layer(
        McpToolAccess.toLayer(CallerToolkit, {
          reads_as_caller: McpToolAccess.readsAsCaller(() => ran),
        }),
      ),
    ).pipe(Effect.scoped, Effect.exit);
    expect(Exit.isFailure(built) && Cause.pretty(built.cause)).toContain(
      "reads_as_caller acts as its calling thread",
    );
  }),
);
