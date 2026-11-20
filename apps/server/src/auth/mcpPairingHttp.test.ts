import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CONNECT_PAIRING_DISCOVERY_PATH,
  EnvironmentHttpApi,
  MCP_PAIRING_AUTHORIZE_PATH,
  MCP_PAIRING_REGISTER_PATH,
  MCP_PAIRING_SCOPES,
  MCP_PAIRING_TOKEN_PATH,
  MCP_PEER_LINK_SOFTWARE_ID,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./http.ts";
import { mcpPairingHttpApiLayer } from "./mcpPairingHttp.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";

class PairingTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}

const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-pairing-test-" })));

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(configLayer),
);

const routesLayer = HttpApiBuilder.layer(PairingTestApi).pipe(
  Layer.provide(authHttpApiLayer),
  Layer.provide(mcpPairingHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
  Layer.provideMerge(environmentAuthLayer),
  Layer.provide(configLayer),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect("serves Connect pairing discovery and exchanges a pairing code", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeed(Option.none()),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );

    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routesLayer, { disableLogger: true })),
      (environment) =>
        Effect.tryPromise(async () => {
          const discovery = await environment.handler(
            new Request(`http://127.0.0.1${CONNECT_PAIRING_DISCOVERY_PATH}`),
            requestContext,
          );
          expect(discovery.status).toBe(200);
          const metadata = (await discovery.json()) as {
            readonly authorization_endpoint: string;
            readonly token_endpoint: string;
            readonly scopes_supported: ReadonlyArray<string>;
          };
          const origin = new URL(metadata.authorization_endpoint).origin;
          expect(metadata.authorization_endpoint).toBe(`${origin}${MCP_PAIRING_AUTHORIZE_PATH}`);
          expect(metadata.token_endpoint).toBe(`${origin}${MCP_PAIRING_TOKEN_PATH}`);
          expect(metadata.scopes_supported).toEqual([...MCP_PAIRING_SCOPES]);

          const authorize = await environment.handler(
            new Request(`http://127.0.0.1${MCP_PAIRING_AUTHORIZE_PATH}`),
            requestContext,
          );
          expect(authorize.status).toBe(200);
          expect(await authorize.json()).toMatchObject({
            pairing: "code",
            peer_software_id: MCP_PEER_LINK_SOFTWARE_ID,
          });

          const registered = await environment.handler(
            new Request(`http://127.0.0.1${MCP_PAIRING_REGISTER_PATH}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encodeJson({ software_id: MCP_PEER_LINK_SOFTWARE_ID, client_name: "Air" }),
            }),
            requestContext,
          );
          expect(registered.status).toBe(200);
          expect(await registered.json()).toMatchObject({
            client_id: MCP_PEER_LINK_SOFTWARE_ID,
            token_endpoint_auth_method: "none",
          });

          const devSession = await environment.handler(
            new Request("http://127.0.0.1/api/auth/browser-session", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encodeJson({ credential: DEV_TOKEN }),
            }),
            requestContext,
          );
          expect(devSession.status).toBe(200);
          const devCookie =
            devSession.headers
              .getSetCookie()
              .find((cookie) => cookie.startsWith("t3_dev_session_"))
              ?.split(";", 1)[0] ?? "";
          expect(devCookie).not.toBe("");

          const pairing = await environment.handler(
            new Request("http://127.0.0.1/api/auth/pairing-token", {
              method: "POST",
              headers: { "content-type": "application/json", cookie: devCookie },
              body: encodeJson({ access: "auto", label: "kara3" }),
            }),
            requestContext,
          );
          expect(pairing.status).toBe(200);
          const issued = (await pairing.json()) as {
            readonly credential: string;
            readonly access?: string;
          };
          expect(issued.access).toBe("auto");

          const token = await environment.handler(
            new Request(`http://127.0.0.1${MCP_PAIRING_TOKEN_PATH}`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code: issued.credential,
                access: "auto",
              }),
            }),
            requestContext,
          );
          expect(token.status).toBe(200);
          const exchanged = (await token.json()) as {
            readonly scope: string;
            readonly token_type: string;
          };
          expect(exchanged.token_type).toBe("Bearer");
          expect(exchanged.scope.split(" ")).toEqual([
            "orchestration:read",
            "orchestration:operate",
          ]);

          const rejected = await environment.handler(
            new Request(`http://127.0.0.1${MCP_PAIRING_TOKEN_PATH}`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code: "not-a-pairing-code",
              }),
            }),
            requestContext,
          );
          expect(rejected.status).toBe(401);
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
