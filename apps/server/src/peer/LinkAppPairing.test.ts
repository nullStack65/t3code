import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  type AuthMcpClientAccess,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  type OrchestratorMcpFailure,
  OrchestratorMcpLinkAppPairingResult,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { Toolkit } from "effect/ai";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { linkAppPairing } from "../mcp/toolkits/orchestrator/handlers.ts";
import { LinkAppPairingTool } from "../mcp/toolkits/orchestrator/tools.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";

const toolkit = Toolkit.make(LinkAppPairingTool);

it.effect.each<{
  readonly access: AuthMcpClientAccess;
  readonly narrowedTo: RuntimeMode;
  readonly added: "read-only" | "full-access";
}>([
  { access: "read-only", narrowedTo: "full-access", added: "read-only" },
  { access: "auto", narrowedTo: "full-access", added: "read-only" },
  { access: "full-access", narrowedTo: "auto", added: "read-only" },
  { access: "full-access", narrowedTo: "full-access", added: "full-access" },
])(
  "a $access link narrowed to $narrowedTo adds a $added app there",
  ({ access, narrowedTo, added }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const box = descriptorOf("environment-box", "Box", { linkedAppPairing: true });
        const handlers = McpToolAccess.toLayer(
          toolkit,
          Effect.map(linkAppPairing, (pairing) => ({ t3_link_app_pairing: pairing })),
        );
        const b = yield* servePeer(box, McpHttpServer.toolkitRegistration(toolkit, handlers));
        const context = yield* Layer.build(
          layerLinkingEnvironment(descriptorOf("environment-a", "A")),
        );
        yield* linkTo(Context.get(context, PeerLinks.PeerLinks), b, access);
        const issued = yield* Context.get(context, PeerMcpClient.PeerMcpClient).call({
          environmentId: box.environmentId,
          tool: "t3_link_app_pairing",
          arguments: {},
          limits: { runtimeMode: narrowedTo, interactionMode: "default" },
          success: OrchestratorMcpLinkAppPairingResult,
        });
        expect(issued.access).toBe(added);
        // The peer lists it with its pairing links, so it can be revoked there before use.
        const listed = (yield* b.auth.listPairingLinks()).find(
          (link) => link.label === "T3 Code · A (app)",
        );
        expect(listed?.permissions).toContain(AuthOrchestrationReadScope);
        expect(listed?.permissions?.includes(AuthOrchestrationOperateScope)).toBe(
          added === "full-access",
        );
        // Asking for more when it is spent gets no more than it carries.
        if (added === "read-only") {
          const broader = yield* b.auth
            .exchangeBootstrapCredentialForAccessToken(
              issued.credential,
              [AuthOrchestrationOperateScope],
              { deviceType: "desktop" },
            )
            .pipe(Effect.flip);
          expect(broader._tag).toBe("ServerAuthScopeNotGrantedError");
        }
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

const caller = (
  client: Partial<McpInvocationContext.McpClientCaller> | undefined,
  thread?: McpInvocationContext.McpThreadCaller,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-box"),
  requestNamespace: "caller",
  thread,
  client:
    client === undefined
      ? undefined
      : { sessionId: "session", label: "Caller", access: "full-access", ...client },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  linkedEnvironments: true,
});

// Discovery offers the tool to links only. The handler must refuse everyone else on its own.
it.effect.each<{
  readonly name: string;
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly code: OrchestratorMcpFailure["code"];
}>([
  { name: "an outside agent", scope: caller({}), code: "capability_denied" },
  {
    name: "an agent's thread here",
    scope: caller(undefined, {
      threadId: ThreadId.make("thread:agent"),
      providerSessionId: "provider:agent",
      providerInstanceId: ProviderInstanceId.make("codex"),
    }),
    code: "capability_denied",
  },
  {
    name: "a link calling for one of its agent threads",
    scope: caller({
      linked: true,
      senderThread: {
        environmentId: EnvironmentId.make("environment-a"),
        threadId: ThreadId.make("thread:linked-agent"),
        title: "Agent",
      },
    }),
    code: "capability_denied",
  },
  // The link itself gets past both checks, to where this harness has no pairing.
  { name: "the link itself", scope: caller({ linked: true }), code: "orchestration_error" },
])("$name calling t3_link_app_pairing gets $code", ({ scope, code }) =>
  Effect.gen(function* () {
    const built = yield* toolkit;
    const { result } = yield* built
      .handle("t3_link_app_pairing", {})
      .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption));
    expect(result).toMatchObject({ code });
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(
        McpToolAccess.toLayer(
          toolkit,
          Effect.map(linkAppPairing, (pairing) => ({ t3_link_app_pairing: pairing })),
        ),
      ),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
  ),
);

it.effect("refuses a link's call made for one of its agent threads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const box = descriptorOf("environment-box", "Box", { linkedAppPairing: true });
      const handlers = McpToolAccess.toLayer(
        toolkit,
        Effect.map(linkAppPairing, (pairing) => ({ t3_link_app_pairing: pairing })),
      );
      const b = yield* servePeer(box, McpHttpServer.toolkitRegistration(toolkit, handlers));
      const context = yield* Layer.build(
        layerLinkingEnvironment(descriptorOf("environment-a", "A")),
      );
      yield* linkTo(Context.get(context, PeerLinks.PeerLinks), b, "full-access");
      const refused = yield* Context.get(context, PeerMcpClient.PeerMcpClient)
        .call({
          environmentId: box.environmentId,
          tool: "t3_link_app_pairing",
          arguments: {},
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          sender: {
            environmentId: EnvironmentId.make("environment-a"),
            threadId: ThreadId.make("thread:linked-agent"),
            title: "Agent",
          },
          success: OrchestratorMcpLinkAppPairingResult,
        })
        .pipe(Effect.flip);
      expect(refused.code).toBe("capability_denied");
      expect(
        (yield* b.auth.listPairingLinks()).some((link) => link.label === "T3 Code · A (app)"),
      ).toBe(false);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
