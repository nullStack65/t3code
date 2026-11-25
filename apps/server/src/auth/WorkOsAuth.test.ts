import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpRouter, HttpServerRequest } from "effect/http";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, base64url } from "jose";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { verifyCodeResponse, WorkOsAuth, layer as workOsLayer } from "./WorkOsAuth.ts";
import { readConfig, WORKOS_PATH } from "./WorkOsConfig.ts";
import * as WorkOsHttp from "./workOsHttp.ts";

const origin = "https://t3.example.test";
const issuer = "https://api.workos.com/";
const clientId = "client_fixture";
const email = "founder@example.test";
const userId = "user_fixture";
const env = {
  T3CODE_WORKOS_AUTH_ENABLED: "true",
  T3CODE_WORKOS_API_KEY: "test-only",
  T3CODE_WORKOS_CLIENT_ID: clientId,
  T3CODE_WORKOS_ISSUER: issuer,
  T3CODE_WORKOS_ORIGIN: origin,
  T3CODE_WORKOS_ORGANIZATION_ID: "org_fixture",
  T3CODE_WORKOS_KAMERON_USER_ID: userId,
  T3CODE_WORKOS_KAMERON_EMAIL: email,
  T3CODE_WORKOS_JEFF_USER_ID: "user_second",
  T3CODE_WORKOS_JEFF_EMAIL: "second@example.test",
};

const withEnv = (values: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(values));

const makeSigner = Effect.fn("WorkOsFixture.makeSigner")(function* () {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const { publicKey, privateKey } = yield* Effect.promise(() => generateKeyPair("RS256"));
  const key = yield* Effect.promise(async () => ({
    ...(await exportJWK(publicKey)),
    kid: "fixture",
  }));
  const jwks = { keys: [key] };
  const makeBody = async (
    input: {
      readonly jwt?: Record<string, unknown>;
      readonly user?: Record<string, unknown>;
      readonly response?: Record<string, unknown>;
      readonly signingKey?: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
    } = {},
  ) => ({
    access_token: await new SignJWT({
      sub: userId,
      sid: "session_fixture",
      client_id: clientId,
      org_id: "org_fixture",
      iss: issuer,
      iat: now,
      exp: now + 120,
      ...input.jwt,
    })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .sign(input.signingKey ?? privateKey),
    user: { id: userId, email, email_verified: true, ...input.user },
    authentication_method: "GoogleOAuth",
    ...input.response,
  });
  return { jwks, makeBody };
});

it.effect("keeps WorkOS disabled without a complete, unambiguous enrollment configuration", () =>
  Effect.gen(function* () {
    expect(yield* readConfig.pipe(Effect.provide(withEnv({})))).toBeNull();
    expect(
      yield* readConfig.pipe(Effect.provide(withEnv({ T3CODE_WORKOS_AUTH_ENABLED: "true" }))),
    ).toBeNull();
    expect(
      yield* readConfig.pipe(
        Effect.provide(withEnv({ ...env, T3CODE_WORKOS_JEFF_USER_ID: userId })),
      ),
    ).toBeNull();
  }),
);

it.effect("verifies issuer, app, time, organization, and both founder identity fields", () =>
  Effect.gen(function* () {
    const config = yield* readConfig.pipe(Effect.provide(withEnv(env)));
    if (!config) return yield* Effect.die("Fixture config did not load");
    const { jwks, makeBody } = yield* makeSigner();
    const key = createLocalJWKSet(jwks);
    const otherKey = yield* Effect.promise(() => generateKeyPair("RS256"));
    const verify = (input?: Parameters<typeof makeBody>[0]) =>
      Effect.promise(() => makeBody(input)).pipe(
        Effect.flatMap((body) => verifyCodeResponse(config, key, body)),
      );
    expect((yield* verify()).founder).toBe("kameron");
    expect(
      (yield* verify({
        jwt: { sub: "user_second" },
        user: { id: "user_second", email: "SECOND@example.test" },
      })).founder,
    ).toBe("jeff");
    for (const [input, status] of [
      [{ signingKey: otherKey.privateKey }, 401],
      [{ jwt: { iss: "https://wrong.example.test/" } }, 401],
      [{ jwt: { exp: -1 } }, 401],
      [{ jwt: { iat: 120 } }, 401],
      [{ jwt: { nbf: 120 } }, 401],
      [{ jwt: { sid: undefined } }, 401],
      [{ jwt: { client_id: "client_other" } }, 401],
      [{ jwt: { aud: "client_other" } }, 401],
      [{ jwt: { client_id: undefined } }, 401],
      [{ jwt: { client_id: clientId, aud: "client_other" } }, 401],
      [{ jwt: { client_id: "client_other", aud: clientId } }, 401],
      [{ jwt: { org_id: "org_other" } }, 403],
      [{ user: { id: "user_other" } }, 401],
      [{ user: { email: "unlisted@example.test" } }, 403],
      [{ user: { email_verified: false } }, 403],
      [{ response: { impersonator: { email } } }, 403],
      [{ response: { authentication_method: "Password" } }, 403],
      [{ jwt: { sub: "user_unlisted" }, user: { id: "user_unlisted" } }, 403],
    ] as const) {
      expect((yield* verify(input).pipe(Effect.flip)).status).toBe(status);
    }
    // Either claim may bind the token to this application, but one must, and none may disagree.
    expect((yield* verify({ jwt: { client_id: undefined, aud: clientId } })).founder).toBe(
      "kameron",
    );
    expect(
      (yield* verify({ jwt: { client_id: undefined, aud: [clientId, "other"] } })).founder,
    ).toBe("kameron");
    expect((yield* verify({ jwt: { client_id: clientId, aud: clientId } })).founder).toBe(
      "kameron",
    );
  }),
);

it.effect(
  "exchanges PKCE once, persists attribution, and revokes the scoped WebSocket session",
  () =>
    Effect.gen(function* () {
      const { jwks, makeBody } = yield* makeSigner();
      const valid = yield* Effect.promise(() => makeBody());
      const invalid = yield* Effect.promise(() => makeBody({ jwt: { exp: -1 } }));
      const unlisted = yield* Effect.promise(() =>
        makeBody({ user: { email: "unlisted@example.test" } }),
      );
      let exchange: { code: string; code_verifier: string } | undefined;
      const mockWorkOs: typeof fetch = async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === `/sso/jwks/${clientId}`) return Response.json(jwks);
        if (path !== "/user_management/authenticate") return new Response(null, { status: 404 });
        exchange = JSON.parse(String(init?.body)) as typeof exchange;
        return Response.json(
          exchange?.code === "expired" ? invalid : exchange?.code === "unlisted" ? unlisted : valid,
        );
      };
      const node = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
      const serverAuthLayer = EnvironmentAuth.layer.pipe(
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerEnvironment.layerIdentity),
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-workos-test-" })),
      );
      const authServices = workOsLayer.pipe(
        Layer.provideMerge(serverAuthLayer),
        Layer.provide(node),
        Layer.provide(withEnv(env)),
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, mockWorkOs)),
      );
      const services = yield* Layer.build(authServices);
      const requestServices = Context.add(services, Clock.Clock, yield* Clock.Clock);
      const sessions = Context.get(services, SessionStore.SessionStore);
      const serverAuth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
      const routes = HttpRouter.toWebHandler(
        WorkOsHttp.layer.pipe(
          Layer.provide(Layer.succeed(WorkOsAuth, Context.get(services, WorkOsAuth))),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(routes.dispose));
      const request = (path: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("host", new URL(origin).host);
        return new Request(new URL(path, origin), { ...init, headers });
      };
      const send = (path: string, init?: RequestInit) =>
        Effect.promise(() => routes.handler(request(path, init), requestServices));
      const open = (desktop?: string) =>
        send(
          `${WORKOS_PATH}/start${desktop ? `?desktop=${desktop}` : ""}`,
          desktop ? {} : { method: "POST", headers: { origin } },
        );
      const finish = (start: Response, code: string, cookie?: string) => {
        const location = new URL(start.headers.get("location")!);
        const state = location.searchParams.get("state")!;
        return send(
          `${WORKOS_PATH}/callback?state=${state}&code=${code}&returnTo=https://other.example.test`,
          {
            headers: { cookie: cookie ?? start.headers.getSetCookie()[0]!.split(";")[0]! },
          },
        );
      };
      expect(
        (yield* send(`${WORKOS_PATH}/start`, {
          method: "POST",
          headers: { origin: "https://other.example.test" },
        })).status,
      ).toBe(403);
      const start = yield* open();
      expect(start.status).toBe(303);
      const authorization = new URL(start.headers.get("location")!);
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorization.searchParams.get("redirect_uri")).toBe(
        `${origin}${WORKOS_PATH}/callback`,
      );
      expect((yield* finish(start, "valid", "wrong=1")).status).toBe(401);
      const complete = yield* finish(start, "valid");
      expect(complete.status).toBe(303);
      expect(complete.headers.get("location")).toBe(`${origin}/`);
      expect(exchange?.code).toBe("valid");
      const verifierDigest = yield* Effect.promise(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(exchange?.code_verifier)),
      );
      expect(base64url.encode(new Uint8Array(verifierDigest))).toBe(
        authorization.searchParams.get("code_challenge"),
      );
      expect((yield* finish(start, "valid")).status).toBe(401);
      expect((yield* finish(yield* open(), "expired")).status).toBe(401);
      expect((yield* finish(yield* open(), "unlisted")).status).toBe(403);
      const sessionCookie = complete.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith(`${sessions.cookieName}=`))!;
      expect(sessionCookie).toMatch(/HttpOnly/i);
      expect(sessionCookie).toMatch(/Secure/i);
      expect(sessionCookie).toMatch(/SameSite=Lax/i);
      const cookie = sessionCookie.split(";")[0]!;
      const upgrade = HttpServerRequest.fromWeb(request("/ws", { headers: { origin, cookie } }));
      const session = yield* serverAuth.authenticateWebSocketUpgrade(upgrade, "rpc");
      expect(yield* serverAuth.messageSenderOf(session.sessionId)).toMatchObject({
        founder: "kameron",
        sessionId: session.sessionId,
      });
      expect(yield* sessions.setFounder(session.sessionId, "jeff")).toBe(false);
      const crossOrigin = HttpServerRequest.fromWeb(
        request("/ws", { headers: { origin: "https://other.example.test", cookie } }),
      );
      expect(
        yield* serverAuth.authenticateWebSocketUpgrade(crossOrigin, "rpc").pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" });
      expect(
        (yield* send(`${WORKOS_PATH}/logout`, { method: "POST", headers: { origin, cookie } }))
          .status,
      ).toBe(303);
      yield* sessions.awaitInvalidation(session.sessionId);
      expect(
        yield* serverAuth.authenticateWebSocketUpgrade(upgrade, "rpc").pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" });

      const mobileGrant = yield* serverAuth.issuePairingCredential({
        scopes: ["orchestration:read"],
      });
      const mobile = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        mobileGrant.credential,
        ["orchestration:read"],
        { deviceType: "mobile" },
      );
      const mobileSession = yield* serverAuth.authenticateHttpRequest(
        HttpServerRequest.fromWeb(
          request("/api/auth/session", {
            headers: { authorization: `Bearer ${mobile.access_token}` },
          }),
        ),
      );
      expect(yield* sessions.setFounder(mobileSession.sessionId, "jeff")).toBe(true);
      expect(
        Option.getOrUndefined(yield* sessions.senderOf(mobileSession.sessionId))?.founder,
      ).toBe("jeff");

      const bootstrap = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "desktop-bootstrap",
      });
      const desktopAuth = {
        authorization: `Bearer ${bootstrap.token}`,
        "content-type": "application/json",
      };
      const verifier = "a".repeat(43);
      const desktopDigest = yield* Effect.promise(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
      );
      const desktopStart = yield* send(`${WORKOS_PATH}/desktop/start`, {
        method: "POST",
        headers: desktopAuth,
        body: JSON.stringify({ challenge: base64url.encode(new Uint8Array(desktopDigest)) }),
      });
      expect(desktopStart.status).toBe(200);
      const { id } = (yield* Effect.promise(() => desktopStart.json())) as { id: string };
      const redeem = (value: string) =>
        send(`${WORKOS_PATH}/desktop/finish`, {
          method: "POST",
          headers: desktopAuth,
          body: JSON.stringify({ id, verifier: value }),
        });
      expect((yield* redeem(verifier)).status).toBe(409);
      const desktopAuthorize = yield* open(id);
      const desktopCallback = yield* finish(desktopAuthorize, "valid");
      expect(desktopCallback.status).toBe(303);
      expect(desktopCallback.headers.getSetCookie()).toHaveLength(1);
      expect((yield* redeem("b".repeat(43))).status).toBe(401);
      const desktopFinish = yield* redeem(verifier);
      expect(desktopFinish.status).toBe(200);
      const { token } = (yield* Effect.promise(() => desktopFinish.json())) as { token: string };
      expect((yield* sessions.verify(token)).method).toBe("bearer-access-token");
      expect(
        (yield* serverAuth.messageSenderOf((yield* sessions.verify(token)).sessionId)).founder,
      ).toBe("kameron");
      expect((yield* redeem(verifier)).status).toBe(401);
    }),
);

const noRemoteClients: ManagedPolicyDocument = {
  schemaVersion: 1,
  organization: "Example Corp",
  limits: { clients: ["desktop", "local-browser"] },
};

it.effect(
  "managed policy without remote clients blocks AuthKit sign-in and revokes its browsers",
  () =>
    Effect.gen(function* () {
      const { jwks, makeBody } = yield* makeSigner();
      const valid = yield* Effect.promise(() => makeBody());
      const mockWorkOs: typeof fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === `/sso/jwks/${clientId}`) return Response.json(jwks);
        if (path === "/user_management/authenticate") return Response.json(valid);
        return new Response(null, { status: 404 });
      };
      const node = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
      const build = (policy?: ManagedPolicyDocument) =>
        Layer.build(
          workOsLayer.pipe(
            Layer.provideMerge(
              EnvironmentAuth.layer.pipe(
                Layer.provide(SqlitePersistence.layerMemory),
                Layer.provide(ServerSecretStore.layer),
                Layer.provide(ServerEnvironment.layerIdentity),
                Layer.provide(ManagedPolicy.layerTest(policy)),
                Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-workos-test-" })),
              ),
            ),
            Layer.provide(node),
            Layer.provide(withEnv(env)),
            Layer.provide(ManagedPolicy.layerTest(policy)),
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, mockWorkOs)),
          ),
        );
      const client = { label: "Browser", deviceType: "desktop" } as const;

      const blocked = yield* build(noRemoteClients);
      const blockedAuth = Context.get(blocked, WorkOsAuth);
      expect((yield* blockedAuth.begin(null).pipe(Effect.flip)).status).toBe(403);
      expect(
        (yield* blockedAuth
          .callback({ state: "s", challengeCookie: "s", code: "valid", client })
          .pipe(Effect.flip)).status,
      ).toBe(403);
      expect(
        (yield* Context.get(blocked, EnvironmentAuth.EnvironmentAuth).getDescriptor())
          .workOsGoogleSignIn,
      ).toBeUndefined();

      const allowed = yield* build();
      expect((yield* Context.get(allowed, WorkOsAuth).begin(null)).state).toBeTruthy();
      expect(
        (yield* Context.get(allowed, EnvironmentAuth.EnvironmentAuth).getDescriptor())
          .workOsGoogleSignIn,
      ).toBe(true);
    }),
);
