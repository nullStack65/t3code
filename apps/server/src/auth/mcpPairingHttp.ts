import {
  type AuthMcpAuthorizationServerMetadata,
  type AuthMcpAuthorizeResult,
  type AuthMcpClientRegistration,
  type AuthMcpProtectedResourceMetadata,
  type AuthMcpRegisteredClient,
  EnvironmentHttpApi,
  MCP_PAIRING_AUTHORIZE_PATH,
  MCP_PAIRING_REGISTER_PATH,
  MCP_PAIRING_SCOPES,
  MCP_PAIRING_TOKEN_PATH,
  MCP_PEER_LINK_SOFTWARE_ID,
  mcpClientScopes,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
} from "./http.ts";
import { deriveAuthClientMetadata } from "./utils.ts";

const DEFAULT_MCP_CLIENT_ID = "t3-mcp-client";
const DEFAULT_MCP_CLIENT_NAME = "MCP client";
const SOFTWARE_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export interface McpPairingUrls {
  readonly issuer: string;
  readonly resource: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly registration_endpoint: string;
}

export function mcpPairingUrls(origin: string): McpPairingUrls {
  return {
    issuer: origin,
    resource: `${origin}/mcp`,
    authorization_endpoint: `${origin}${MCP_PAIRING_AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${MCP_PAIRING_TOKEN_PATH}`,
    registration_endpoint: `${origin}${MCP_PAIRING_REGISTER_PATH}`,
  };
}

export function protectedResourceMetadata(urls: McpPairingUrls): AuthMcpProtectedResourceMetadata {
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    scopes_supported: MCP_PAIRING_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "T3 Code",
  };
}

export function authorizationServerMetadata(
  urls: McpPairingUrls,
): AuthMcpAuthorizationServerMetadata {
  return {
    issuer: urls.issuer,
    authorization_endpoint: urls.authorization_endpoint,
    token_endpoint: urls.token_endpoint,
    registration_endpoint: urls.registration_endpoint,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: MCP_PAIRING_SCOPES,
    authorization_response_iss_parameter_supported: true,
  };
}

export function authorizeResult(urls: McpPairingUrls): AuthMcpAuthorizeResult {
  return {
    pairing: "code",
    token_endpoint: urls.token_endpoint,
    scopes_supported: MCP_PAIRING_SCOPES,
    peer_software_id: MCP_PEER_LINK_SOFTWARE_ID,
  };
}

export function registerMcpClient(
  registration: AuthMcpClientRegistration,
): AuthMcpRegisteredClient | undefined {
  const softwareId = registration.software_id?.trim();
  if (softwareId !== undefined && softwareId.length > 0 && !SOFTWARE_ID_PATTERN.test(softwareId)) {
    return undefined;
  }
  const clientName = registration.client_name?.trim();
  return {
    client_id: softwareId && softwareId.length > 0 ? softwareId : DEFAULT_MCP_CLIENT_ID,
    client_name:
      clientName && clientName.length > 0 ? clientName.slice(0, 100) : DEFAULT_MCP_CLIENT_NAME,
    token_endpoint_auth_method: "none",
  };
}

const requestOrigin = Effect.map(HttpServerRequest.HttpServerRequest, (request) => {
  const url = HttpServerRequest.toURL(request);
  return Option.isSome(url) ? url.value.origin : "http://127.0.0.1";
});

export const mcpPairingHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "mcpOAuth",
  Effect.fnUntraced(function* (handlers) {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

    return handlers
      .handle(
        "protectedResource",
        Effect.fn("environment.mcp.protectedResource")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return protectedResourceMetadata(mcpPairingUrls(yield* requestOrigin));
        }),
      )
      .handle(
        "mcpProtectedResource",
        Effect.fn("environment.mcp.mcpProtectedResource")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return protectedResourceMetadata(mcpPairingUrls(yield* requestOrigin));
        }),
      )
      .handle(
        "authorizationServer",
        Effect.fn("environment.mcp.authorizationServer")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return authorizationServerMetadata(mcpPairingUrls(yield* requestOrigin));
        }),
      )
      .handle(
        "authorize",
        Effect.fn("environment.mcp.authorize")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return authorizeResult(mcpPairingUrls(yield* requestOrigin));
        }),
      )
      .handle(
        "register",
        Effect.fn("environment.mcp.register")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const registered = registerMcpClient(args.payload);
          if (!registered) {
            return yield* failEnvironmentInvalidRequest("invalid_command");
          }
          return registered;
        }),
      )
      .handle(
        "token",
        Effect.fn("environment.mcp.token")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            yield* HttpEffect.appendPreResponseHandler((_httpRequest, response) =>
              Effect.succeed(
                HttpServerResponse.setHeaders(response, {
                  "cache-control": "no-store",
                  pragma: "no-cache",
                }),
              ),
            );
            return yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
              args.payload.code,
              mcpClientScopes(args.payload.access ?? "auto"),
              deriveAuthClientMetadata({ request }),
            );
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInvalidRequestError, (error) =>
            failEnvironmentInvalidRequest(EnvironmentAuth.serverAuthInvalidRequestReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("access_token_issuance_failed", error),
          ),
        ),
      );
  }),
);
