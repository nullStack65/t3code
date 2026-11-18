import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  type AuthMcpClientAccess,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  OrchestratorMcpLinkAppPairingResult,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Toolkit } from "effect/ai";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
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
