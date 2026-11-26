import { AuthStandardClientScopes, type Founder } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, type HttpServerRequest } from "effect/http";
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from "jose";

import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { requestUrl } from "../requestUrl.ts";
import * as SessionStore from "./SessionStore.ts";
import {
  cloudflareAccessSubjectFor,
  readCloudflareAccessConfig,
  type CloudflareAccessConfig,
} from "./CloudflareAccessConfig.ts";
import { deriveAuthClientMetadata } from "./utils.ts";

const sessionLifetimeMs = 8 * 60 * 60_000;
const jwksCacheMaxAgeMs = 30 * 60_000;
const jwksCooldownMs = 30_000;
const jwksTimeoutMs = 5_000;
const maxJwtLength = 8_192;
const maxIatFutureSkewSeconds = 60;

class CloudflareAccessError extends Schema.TaggedError<CloudflareAccessError>()(
  "CloudflareAccessError",
  {
    status: Schema.Literals([401, 403]),
    message: Schema.String,
  },
) {}

const invalid = () =>
  new CloudflareAccessError({
    status: 401,
    message: "Cloudflare Access JWT could not be verified.",
  });

const denied = () =>
  new CloudflareAccessError({
    status: 403,
    message: "This Cloudflare Access identity is not enrolled for this environment.",
  });

interface CloudflareAccessIdentity {
  readonly founder: Founder;
  readonly expiresAt: number;
}

function extractCloudflareAccessJwt(request: HttpServerRequest.HttpServerRequest): string | null {
  const fromHeader = request.headers["cf-access-jwt-assertion"];
  const raw =
    typeof fromHeader === "string" && fromHeader.trim().length > 0
      ? fromHeader.trim()
      : request.cookies["CF_Authorization"]?.trim();
  if (!raw || raw.length > maxJwtLength) {
    return null;
  }
  return raw;
}

function isAllowedCloudflareAccessSessionRequest(
  config: CloudflareAccessConfig,
  request: HttpServerRequest.HttpServerRequest,
): boolean {
  if (request.headers.authorization !== undefined) {
    return false;
  }
  const url = requestUrl(request);
  if (Option.isNone(url)) {
    return false;
  }
  const requestOrigin = url.value.origin;
  if (!config.allowedOrigins.includes(requestOrigin)) {
    return false;
  }
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== requestOrigin) {
    return false;
  }
  const secFetchSite = request.headers["sec-fetch-site"];
  if (secFetchSite !== undefined && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return false;
  }
  return true;
}

/** @public Test seam for signed Cloudflare Access JWTs. */
export const verifyCloudflareAccessJwt = Effect.fn("CloudflareAccessAuth.verifyJwt")(function* (
  config: CloudflareAccessConfig,
  key: JWTVerifyGetKey,
  token: string,
) {
  const now = yield* DateTime.now;
  const { payload } = yield* Effect.tryPromise({
    try: () =>
      jwtVerify(token, key, {
        algorithms: ["RS256"],
        issuer: config.teamDomain,
        audience: [...config.audiences],
        requiredClaims: ["sub", "email", "iat", "exp"],
        currentDate: DateTime.toDate(now),
      }),
    catch: invalid,
  });

  if (
    typeof payload.sub !== "string" ||
    payload.sub.trim().length === 0 ||
    typeof payload.email !== "string" ||
    payload.email.trim().length === 0 ||
    typeof payload.iat !== "number" ||
    payload.iat > now.epochMilliseconds / 1000 + maxIatFutureSkewSeconds ||
    typeof payload.exp !== "number"
  ) {
    return yield* invalid();
  }

  // Cloudflare Access user identity JWTs carry type="app"; reject service tokens or other token types.
  if (payload.type !== "app") {
    return yield* denied();
  }

  const email = payload.email.trim().toLowerCase();
  for (const founder of ["kameron", "jeff"] as const) {
    if (config.founders[founder].emails.includes(email)) {
      return {
        founder,
        expiresAt: Math.min(payload.exp * 1000, now.epochMilliseconds + sessionLifetimeMs),
      } satisfies CloudflareAccessIdentity;
    }
  }
  return yield* denied();
});

export interface CloudflareAccessMintedSession extends SessionStore.IssuedSession {
  readonly founder: Founder;
}

export class CloudflareAccessAuth extends Context.Service<
  CloudflareAccessAuth,
  {
    readonly config: CloudflareAccessConfig | null;
    readonly tryAutoMintBrowserSession: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<CloudflareAccessMintedSession | null>;
  }
>()("t3/auth/CloudflareAccessAuth") {}

const make = Effect.fn("CloudflareAccessAuth.make")(function* (options?: {
  readonly jwksCooldownMs?: number;
}) {
  const config = yield* readCloudflareAccessConfig;
  const sessions = yield* SessionStore.SessionStore;
  const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
  const fetchJwks = yield* FetchHttpClient.Fetch;
  const key =
    config &&
    createRemoteJWKSet(config.jwksUrl, {
      timeoutDuration: jwksTimeoutMs,
      cooldownDuration: options?.jwksCooldownMs ?? jwksCooldownMs,
      cacheMaxAge: jwksCacheMaxAgeMs,
      [customFetch]: fetchJwks,
    });

  const tryAutoMintBrowserSession: CloudflareAccessAuth["Service"]["tryAutoMintBrowserSession"] =
    Effect.fn("CloudflareAccessAuth.tryAutoMintBrowserSession")(function* (request) {
      if (!config || !key) return null;
      if (!ManagedLimits.allowsRemoteClients(managedPolicy)) return null;
      if (!isAllowedCloudflareAccessSessionRequest(config, request)) return null;
      const token = extractCloudflareAccessJwt(request);
      if (!token) return null;

      const identity = yield* verifyCloudflareAccessJwt(config, key, token).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Rejected Cloudflare Access JWT during session bootstrap.", {
            status: error.status,
            reason: error.message,
          }).pipe(Effect.as(null)),
        ),
      );
      if (!identity) return null;

      const now = yield* DateTime.now;
      if (identity.expiresAt <= now.epochMilliseconds) return null;

      return yield* sessions
        .issue({
          method: "browser-session-cookie",
          client: deriveAuthClientMetadata({ request }),
          founder: identity.founder,
          subject: cloudflareAccessSubjectFor(config, identity.founder),
          expiresAt: DateTime.makeUnsafe(identity.expiresAt),
          scopes: AuthStandardClientScopes,
        })
        .pipe(
          Effect.map((issued): CloudflareAccessMintedSession => ({
            ...issued,
            founder: identity.founder,
          })),
          Effect.catch((cause) =>
            Effect.logWarning("Failed to issue T3 browser session from Cloudflare Access JWT.", {
              cause,
            }).pipe(Effect.as(null)),
          ),
        );
    });

  return CloudflareAccessAuth.of({ config, tryAutoMintBrowserSession });
});

/** @public Test seam for configuring JWKS cooldown. */
export const makeLayer = (options?: { readonly jwksCooldownMs?: number }) =>
  Layer.effect(CloudflareAccessAuth, make(options)).pipe(Layer.provide(FetchHttpClient.layer));

export const layer = makeLayer();
