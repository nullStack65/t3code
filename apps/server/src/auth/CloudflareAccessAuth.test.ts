import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter, HttpServerRequest } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as CloudflareAccessAuth from "./CloudflareAccessAuth.ts";
import { readCloudflareAccessConfig } from "./CloudflareAccessConfig.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as AuthHttp from "./http.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const teamDomain = "https://closura.cloudflareaccess.com";
const prodOrigin = "https://t3code.closura.ai";
const stagingOrigin = "https://t3code-staging.closura.ai";
const prodAud = "3a359355728dfd5fe08ef8dec4cecdaea54d2fc37abdc3497e5292c697dafa20";
const stagingAud = "9b218477619efe6af19ff9efd5dfdebf65e3fd48bced4508f6303d708efbfb31";

const env = {
  T3CODE_CF_ACCESS_AUTH_ENABLED: "true",
  T3CODE_CF_ACCESS_TEAM_DOMAIN: teamDomain,
  T3CODE_CF_ACCESS_AUD: `${prodAud},${stagingAud}`,
  T3CODE_CF_ACCESS_ALLOWED_ORIGINS: `${prodOrigin},${stagingOrigin}`,
  T3CODE_CF_ACCESS_KAMERON_EMAIL: "kameron.smith@closura.ai",
  T3CODE_CF_ACCESS_JEFF_EMAIL: "jeffrey.smith@closura.ai, jeff.smith@closura.ai",
};

const noRemoteClients: ManagedPolicyDocument = {
  schemaVersion: 1,
  organization: "Example Corp",
  limits: { clients: ["desktop", "local-browser"] },
};

const withEnv = (values: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(values));

const nodeLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

const makeRequestContext = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeedNone,
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.die("Not used by these routes."),
    remove: () => Effect.void,
  });
  return Context.make(SecureRandom.SecureRandom, random).pipe(
    Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
  );
}).pipe(Effect.provide(NodeCrypto.layer));

const makeSigner = Effect.fn("CloudflareAccessFixture.makeSigner")(function* (kid = "cf-key-1") {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const { publicKey, privateKey } = yield* Effect.promise(() => generateKeyPair("RS256"));
  const jwk = yield* Effect.promise(async () => ({
    ...(await exportJWK(publicKey)),
    kid,
    alg: "RS256",
    use: "sig",
  }));
  const sign = async (
    input: {
      readonly claims?: Record<string, unknown>;
      readonly kid?: string;
      readonly signingKey?: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
    } = {},
  ) =>
    new SignJWT({
      sub: "cf-user-123",
      email: "kameron.smith@closura.ai",
      type: "app",
      iss: teamDomain,
      aud: [prodAud],
      iat: now,
      exp: now + 3600,
      ...input.claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: input.kid ?? kid })
      .sign(input.signingKey ?? privateKey);
  return { jwk, jwks: { keys: [jwk] }, sign };
});

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const buildAuthHttpHarness = (options: {
  readonly envValues: Record<string, string>;
  readonly jwksResponse: () => Response | Promise<Response>;
  readonly managedPolicy?: ManagedPolicyDocument;
  readonly jwksCooldownMs?: number;
}) => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${teamDomain}/cdn-cgi/access/certs`) {
      return await options.jwksResponse();
    }
    return new Response("not found", { status: 404 });
  };

  const layerConfig = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-cf-access-test-",
  });
  const layerPersistence = SqlitePersistence.layerMemory;
  const layerManagedPolicy = options.managedPolicy
    ? ManagedPolicy.layerTest(options.managedPolicy)
    : ManagedPolicy.layerTest();
  const layerEnvAuth = EnvironmentAuth.layer.pipe(
    Layer.provide(layerManagedPolicy),
    Layer.provide(layerPersistence),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerConfig),
    Layer.provide(withEnv(options.envValues)),
  );
  const layerCfAccess = CloudflareAccessAuth.makeLayer(
    options.jwksCooldownMs === undefined ? undefined : { jwksCooldownMs: options.jwksCooldownMs },
  ).pipe(
    Layer.provide(layerEnvAuth),
    Layer.provide(layerManagedPolicy),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImpl)),
    Layer.provide(withEnv(options.envValues)),
  );
  const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
    Layer.provide(AuthHttp.layer),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provideMerge(layerCfAccess),
    Layer.provideMerge(layerEnvAuth),
    Layer.provide(layerConfig),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(Layer.provideMerge(nodeLayer), Layer.provideMerge(Etag.layerWeak)),
    ),
    Layer.provide(nodeLayer),
  );
  return { layerRoutes, layerEnvAuth, layerPersistence, layerConfig };
};

it.effect("keeps Cloudflare Access disabled without a complete, unambiguous configuration", () =>
  Effect.gen(function* () {
    expect(yield* readCloudflareAccessConfig.pipe(Effect.provide(withEnv({})))).toBeNull();
    expect(
      yield* readCloudflareAccessConfig.pipe(
        Effect.provide(withEnv({ T3CODE_CF_ACCESS_AUTH_ENABLED: "true" })),
      ),
    ).toBeNull();
    // Overlapping founder emails must fail closed.
    expect(
      yield* readCloudflareAccessConfig.pipe(
        Effect.provide(
          withEnv({
            ...env,
            T3CODE_CF_ACCESS_JEFF_EMAIL: "jeffrey.smith@closura.ai,kameron.smith@closura.ai",
          }),
        ),
      ),
    ).toBeNull();
    // Non-HTTPS origin must fail closed.
    expect(
      yield* readCloudflareAccessConfig.pipe(
        Effect.provide(
          withEnv({
            ...env,
            T3CODE_CF_ACCESS_ALLOWED_ORIGINS: "http://t3code.closura.ai",
          }),
        ),
      ),
    ).toBeNull();
    const valid = yield* readCloudflareAccessConfig.pipe(Effect.provide(withEnv(env)));
    expect(valid).not.toBeNull();
    expect(valid?.audiences).toEqual([prodAud, stagingAud]);
    expect(valid?.allowedOrigins).toEqual([prodOrigin, stagingOrigin]);
    expect(valid?.founders.jeff.emails).toEqual([
      "jeffrey.smith@closura.ai",
      "jeff.smith@closura.ai",
    ]);
  }),
);

it.effect("verifies RS256 signature, issuer, audience, type, time, and founder email aliases", () =>
  Effect.gen(function* () {
    const config = yield* readCloudflareAccessConfig.pipe(Effect.provide(withEnv(env)));
    if (!config) return yield* Effect.die("Fixture config did not load");
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const { jwks, sign } = yield* makeSigner();
    const key = createLocalJWKSet(jwks);
    const otherKey = yield* Effect.promise(() => generateKeyPair("RS256"));
    const verify = (input?: Parameters<typeof sign>[0]) =>
      Effect.promise(() => sign(input)).pipe(
        Effect.flatMap((token) =>
          CloudflareAccessAuth.verifyCloudflareAccessJwt(config, key, token),
        ),
      );

    expect((yield* verify()).founder).toBe("kameron");
    expect(
      (yield* verify({
        claims: { email: "JEFF.SMITH@closura.ai", aud: [stagingAud] },
      })).founder,
    ).toBe("jeff");
    expect(
      (yield* verify({
        claims: { email: "jeffrey.smith@closura.ai", aud: [prodAud] },
      })).founder,
    ).toBe("jeff");

    for (const [input, status] of [
      [{ signingKey: otherKey.privateKey }, 401],
      [{ claims: { iss: "https://other.cloudflareaccess.com" } }, 401],
      [
        {
          claims: {
            aud: ["0000000000000000000000000000000000000000000000000000000000000000"],
          },
        },
        401,
      ],
      [{ claims: { exp: -1 } }, 401],
      [{ claims: { iat: nowSeconds + 3600 } }, 401],
      [{ claims: { type: "service_token" } }, 403],
      [{ claims: { email: "intruder@closura.ai" } }, 403],
    ] as const) {
      const error = yield* verify(input).pipe(Effect.flip);
      expect(error.status).toBe(status);
    }
  }),
);

it.live(
  "auto-mints a browser session cookie on GET /api/auth/session without Origin header (mobile Safari/Chrome)",
  () =>
    Effect.gen(function* () {
      const requestContext = yield* makeRequestContext;
      const { jwks, sign } = yield* makeSigner();
      let jwksFetches = 0;
      const { layerRoutes } = buildAuthHttpHarness({
        envValues: env,
        jwksCooldownMs: 0,
        jwksResponse: () => {
          jwksFetches += 1;
          return Response.json(jwks);
        },
      });
      const token = yield* Effect.promise(() => sign());

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
        (web) =>
          Effect.promise(async () => {
            // Mobile Safari/Chrome omits Origin on same-origin GET /api/auth/session.
            const first = await web.handler(
              new Request("http://127.0.0.1/api/auth/session", {
                method: "GET",
                headers: {
                  host: "t3code.closura.ai",
                  "x-forwarded-proto": "https",
                  "sec-fetch-site": "same-origin",
                  "cf-access-jwt-assertion": token,
                },
              }),
              requestContext,
            );
            expect(first.status).toBe(200);
            const firstBody = (await first.json()) as {
              authenticated: boolean;
              sessionMethod?: string;
              sessionId?: string;
            };
            expect(firstBody.authenticated).toBe(true);
            expect(firstBody.sessionMethod).toBe("browser-session-cookie");
            const setCookie = first.headers.get("set-cookie");
            expect(setCookie).toBeTruthy();
            expect(setCookie).toContain("HttpOnly");
            expect(setCookie).toContain("Secure");
            expect(jwksFetches).toBe(1);

            // Subsequent request uses the minted T3 session cookie directly (no extra JWKS fetch or remint).
            const cookiePair = setCookie!.split(";", 1)[0]!;
            const second = await web.handler(
              new Request("http://127.0.0.1/api/auth/session", {
                method: "GET",
                headers: {
                  host: "t3code.closura.ai",
                  "x-forwarded-proto": "https",
                  "sec-fetch-site": "same-origin",
                  cookie: cookiePair,
                },
              }),
              requestContext,
            );
            expect(second.status).toBe(200);
            const secondBody = (await second.json()) as {
              authenticated: boolean;
              sessionId?: string;
            };
            expect(secondBody.authenticated).toBe(true);
            expect(secondBody.sessionId).toBe(firstBody.sessionId);
            expect(second.headers.get("set-cookie")).toBeNull();
            expect(jwksFetches).toBe(1);

            // Cross-origin request with a valid JWT must NOT mint a session.
            const crossOrigin = await web.handler(
              new Request("http://127.0.0.1/api/auth/session", {
                method: "GET",
                headers: {
                  host: "t3code.closura.ai",
                  "x-forwarded-proto": "https",
                  origin: "https://evil.example.test",
                  "cf-access-jwt-assertion": token,
                },
              }),
              requestContext,
            );
            expect(crossOrigin.status).toBe(200);
            expect((await crossOrigin.json()) as { authenticated: boolean }).toMatchObject({
              authenticated: false,
            });
            expect(crossOrigin.headers.get("set-cookie")).toBeNull();

            // Unallowed host must NOT mint a session.
            const wrongHost = await web.handler(
              new Request("http://127.0.0.1/api/auth/session", {
                method: "GET",
                headers: {
                  host: "other.closura.ai",
                  "x-forwarded-proto": "https",
                  "cf-access-jwt-assertion": token,
                },
              }),
              requestContext,
            );
            expect(wrongHost.status).toBe(200);
            expect((await wrongHost.json()) as { authenticated: boolean }).toMatchObject({
              authenticated: false,
            });
            expect(wrongHost.headers.get("set-cookie")).toBeNull();

            // Unverified email header alone must NEVER authenticate.
            const headerSpoof = await web.handler(
              new Request("http://127.0.0.1/api/auth/session", {
                method: "GET",
                headers: {
                  host: "t3code.closura.ai",
                  "x-forwarded-proto": "https",
                  "cf-access-authenticated-user-email": "kameron.smith@closura.ai",
                },
              }),
              requestContext,
            );
            expect(headerSpoof.status).toBe(200);
            expect((await headerSpoof.json()) as { authenticated: boolean }).toMatchObject({
              authenticated: false,
            });
          }),
        (web) => Effect.promise(() => web.dispose()),
      );
    }),
);

it.effect("attributes founder on minted cf-access session and rejects it on origin mismatch", () =>
  Effect.gen(function* () {
    const { jwks, sign } = yield* makeSigner();
    const token = yield* Effect.promise(() => sign({ claims: { email: "jeff.smith@closura.ai" } }));
    const { layerEnvAuth } = buildAuthHttpHarness({
      envValues: env,
      jwksResponse: () => Response.json(jwks),
    });

    const layerWithCf = CloudflareAccessAuth.layer.pipe(
      Layer.provideMerge(layerEnvAuth),
      Layer.provide(ManagedPolicy.layerTest()),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, async () => Response.json(jwks))),
      Layer.provide(withEnv(env)),
      Layer.provide(nodeLayer),
    );

    const services = yield* Layer.build(layerWithCf);
    const cfAuth = Context.get(services, CloudflareAccessAuth.CloudflareAccessAuth);
    const envAuth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
    const sessions = Context.get(services, SessionStore.SessionStore);

    const mintRequest = HttpServerRequest.fromWeb(
      new Request("http://127.0.0.1/api/auth/session", {
        method: "GET",
        headers: {
          host: "t3code.closura.ai",
          "x-forwarded-proto": "https",
          cookie: `CF_Authorization=${token}`,
        },
      }),
    );
    const minted = yield* cfAuth.tryAutoMintBrowserSession(mintRequest);
    expect(minted).not.toBeNull();

    const active = yield* sessions.listActive();
    const record = active.find((row) => row.sessionId === minted!.sessionId);
    expect(record?.founder).toBe("jeff");

    // Valid on allowed origin with cookie.
    const validState = yield* envAuth.getSessionState(
      HttpServerRequest.fromWeb(
        new Request("http://127.0.0.1/api/auth/session", {
          method: "GET",
          headers: {
            host: "t3code.closura.ai",
            "x-forwarded-proto": "https",
            cookie: `${sessions.cookieName}=${minted!.token}`,
          },
        }),
      ),
    );
    expect(validState.authenticated).toBe(true);

    // Rejected on unallowed origin.
    const wrongOriginState = yield* envAuth.getSessionState(
      HttpServerRequest.fromWeb(
        new Request("http://127.0.0.1/api/auth/session", {
          method: "GET",
          headers: {
            host: "other.closura.ai",
            "x-forwarded-proto": "https",
            cookie: `${sessions.cookieName}=${minted!.token}`,
          },
        }),
      ),
    );
    expect(wrongOriginState.authenticated).toBe(false);
  }),
);

it.live(
  "refreshes JWKS on unknown kid rotation and blocks auto-mint when ManagedPolicy disallows remote clients",
  () =>
    Effect.gen(function* () {
      const requestContext = yield* makeRequestContext;
      const key1 = yield* makeSigner("cf-key-1");
      const key2 = yield* makeSigner("cf-key-2");
      let currentJwks = key1.jwks;
      let jwksFetches = 0;

      const { layerRoutes } = buildAuthHttpHarness({
        envValues: env,
        jwksCooldownMs: 0,
        jwksResponse: () => {
          jwksFetches += 1;
          return Response.json(currentJwks);
        },
      });
      const token1 = yield* Effect.promise(() => key1.sign());
      const token2 = yield* Effect.promise(() =>
        key2.sign({ claims: { email: "jeffrey.smith@closura.ai", aud: [stagingAud] } }),
      );

      yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
        (web) =>
          Effect.promise(async () => {
            const first = await web.handler(
              new Request("http://127.0.0.1/api/auth/session", {
                method: "GET",
                headers: {
                  host: "t3code.closura.ai",
                  "x-forwarded-proto": "https",
                  "cf-access-jwt-assertion": token1,
                },
              }),
              requestContext,
            );
            expect(first.status).toBe(200);
            expect((await first.json()) as { authenticated: boolean }).toMatchObject({
              authenticated: true,
            });
            expect(jwksFetches).toBe(1);

            // Rotate JWKS to key2 and send a token signed with unknown kid "cf-key-2".
            currentJwks = key2.jwks;
            const rotated = await web.handler(
              new Request("http://127.0.0.1/api/auth/session", {
                method: "GET",
                headers: {
                  host: "t3code-staging.closura.ai",
                  "x-forwarded-proto": "https",
                  "cf-access-jwt-assertion": token2,
                },
              }),
              requestContext,
            );
            expect(rotated.status).toBe(200);
            expect((await rotated.json()) as { authenticated: boolean }).toMatchObject({
              authenticated: true,
            });
            expect(jwksFetches).toBe(2);
          }),
        (web) => Effect.promise(() => web.dispose()),
      );

      // ManagedPolicy disallowing remote clients must block auto-minting.
      const { layerRoutes: blockedRoutes } = buildAuthHttpHarness({
        envValues: env,
        jwksResponse: () => Response.json(key1.jwks),
        managedPolicy: noRemoteClients,
      });
      yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(blockedRoutes, { disableLogger: true })),
        (web) =>
          Effect.promise(async () => {
            const blocked = await web.handler(
              new Request("http://127.0.0.1/api/auth/session", {
                method: "GET",
                headers: {
                  host: "t3code.closura.ai",
                  "x-forwarded-proto": "https",
                  "cf-access-jwt-assertion": token1,
                },
              }),
              requestContext,
            );
            expect(blocked.status).toBe(200);
            expect((await blocked.json()) as { authenticated: boolean }).toMatchObject({
              authenticated: false,
            });
            expect(blocked.headers.get("set-cookie")).toBeNull();
          }),
        (web) => Effect.promise(() => web.dispose()),
      );
    }),
);
