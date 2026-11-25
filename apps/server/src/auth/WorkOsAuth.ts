// @effect-diagnostics nodeBuiltinImport:off - PKCE and state use the same synchronous generation as the transaction maps.
import * as NodeCrypto from "node:crypto";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthClientMetadata,
  type Founder,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SessionStore from "./SessionStore.ts";
import { readConfig, subjectFor, WORKOS_PATH, type WorkOsConfig } from "./WorkOsConfig.ts";

const transactionLifetimeMs = 5 * 60_000;
const sessionLifetimeMs = 15 * 60_000;
const maxPending = 512;
const workOsApi = "https://api.workos.com";
export const transactionCookie = "__Host-t3-workos-state";
const opaque = () => NodeCrypto.randomBytes(32).toString("base64url");
const challenge = (verifier: string) =>
  NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
const isOpaque = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);

export class WorkOsError extends Schema.TaggedError<WorkOsError>()("WorkOsError", {
  status: Schema.Literals([401, 403, 404, 409, 429, 502, 503]),
  message: Schema.String,
}) {}

const invalid = () =>
  new WorkOsError({ status: 401, message: "Google sign-in could not be verified. Start again." });
const denied = () =>
  new WorkOsError({
    status: 403,
    message: "This Google account is not enrolled for this environment.",
  });
const unavailable = () =>
  new WorkOsError({ status: 503, message: "Could not establish a T3 Code session." });
const remoteClientsDisallowed = () =>
  new WorkOsError({
    status: 403,
    message: "Your organization's policy does not allow remote clients to sign in.",
  });
const upstreamUnavailable = () =>
  new WorkOsError({ status: 502, message: "WorkOS is unavailable. Start again." });

const responseSchema = Schema.Struct({
  access_token: Schema.String,
  authentication_method: Schema.optionalKey(Schema.String),
  impersonator: Schema.optionalKey(Schema.Unknown),
  user: Schema.Struct({ id: Schema.String, email: Schema.String, email_verified: Schema.Boolean }),
});
const decodeResponse = Schema.decodeUnknownEffect(responseSchema);

/**
 * Fail closed: the token must name this application in `client_id` or `aud`, and any claim it
 * does carry must name it too, so a token minted for another application or for none is refused.
 */
const boundToClient = (payload: JWTPayload, clientId: string) => {
  const audienceMatches =
    payload.aud === clientId || (Array.isArray(payload.aud) && payload.aud.includes(clientId));
  return (
    (payload.client_id === clientId || audienceMatches) &&
    (payload.client_id === undefined || payload.client_id === clientId) &&
    (payload.aud === undefined || audienceMatches)
  );
};

interface Identity {
  readonly founder: Founder;
  readonly expiresAt: number;
}

/** @public Test seam for signed WorkOS code-exchange responses. */
export const verifyCodeResponse = Effect.fn("WorkOsAuth.verifyCodeResponse")(function* (
  config: WorkOsConfig,
  key: JWTVerifyGetKey,
  body: unknown,
) {
  const response = yield* decodeResponse(body).pipe(Effect.mapError(invalid));
  const now = yield* DateTime.now;
  const { payload } = yield* Effect.tryPromise({
    try: () =>
      jwtVerify(response.access_token, key, {
        algorithms: ["RS256"],
        issuer: config.issuer,
        requiredClaims: ["sub", "sid", "iat", "exp"],
        currentDate: DateTime.toDate(now),
      }),
    catch: invalid,
  });
  if (
    !payload.sub ||
    typeof payload.sid !== "string" ||
    !payload.sid ||
    payload.sub !== response.user.id ||
    typeof payload.iat !== "number" ||
    payload.iat > now.epochMilliseconds / 1000 ||
    typeof payload.exp !== "number" ||
    !boundToClient(payload, config.clientId)
  )
    return yield* invalid();

  if (
    response.impersonator != null ||
    payload.impersonator != null ||
    response.authentication_method !== "GoogleOAuth" ||
    !response.user.email_verified ||
    (config.organizationId !== undefined && payload.org_id !== config.organizationId)
  )
    return yield* denied();

  for (const founder of ["kameron", "jeff"] as const) {
    const allow = config.founders[founder];
    if (allow.id === payload.sub && allow.email === response.user.email.trim().toLowerCase()) {
      return {
        founder,
        expiresAt: Math.min(payload.exp * 1000, now.epochMilliseconds + sessionLifetimeMs),
      } satisfies Identity;
    }
  }
  return yield* denied();
});

interface DesktopTransaction {
  readonly challenge: string;
  readonly expiresAt: number;
  started: boolean;
  identity?: Identity;
}

interface BrowserTransaction {
  readonly verifier: string;
  readonly expiresAt: number;
  readonly desktop?: DesktopTransaction;
}

export class WorkOsAuth extends Context.Service<
  WorkOsAuth,
  {
    readonly config: WorkOsConfig | null;
    readonly startDesktop: (
      accessToken: string,
      verifierChallenge: string,
    ) => Effect.Effect<string, WorkOsError>;
    readonly begin: (
      desktop: string | null,
    ) => Effect.Effect<{ state: string; location: URL }, WorkOsError>;
    readonly callback: (input: {
      state: string;
      challengeCookie: string;
      code: string;
      client: AuthClientMetadata;
      previousCookie?: string;
    }) => Effect.Effect<SessionStore.IssuedSession | null, WorkOsError>;
    readonly finishDesktop: (
      accessToken: string,
      id: string,
      verifier: string,
    ) => Effect.Effect<SessionStore.IssuedSession, WorkOsError>;
    readonly signOut: (token: string) => Effect.Effect<void, WorkOsError>;
  }
>()("t3/auth/WorkOsAuth") {}

const make = Effect.gen(function* () {
  const config = yield* readConfig;
  const sessions = yield* SessionStore.SessionStore;
  const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
  const http = yield* HttpClient.HttpClient;
  const fetchJwks = yield* FetchHttpClient.Fetch;
  const browser = new Map<string, BrowserTransaction>();
  const desktop = new Map<string, DesktopTransaction>();
  const key =
    config &&
    createRemoteJWKSet(new URL(`/sso/jwks/${config.clientId}`, workOsApi), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      [customFetch]: fetchJwks,
    });

  const requireDesktopBootstrap = Effect.fn("WorkOsAuth.requireDesktopBootstrap")(function* (
    token: string,
  ) {
    const session = yield* sessions.verify(token).pipe(Effect.mapError(invalid));
    if (session.subject !== "desktop-bootstrap" || session.method !== "bearer-access-token") {
      return yield* denied();
    }
  });

  const issue = Effect.fn("WorkOsAuth.issue")(function* (
    configured: WorkOsConfig,
    identity: Identity,
    client: AuthClientMetadata,
    method: "browser-session-cookie" | "bearer-access-token",
    previousCookie?: string,
  ) {
    const now = yield* DateTime.now;
    if (identity.expiresAt <= now.epochMilliseconds) return yield* invalid();
    const previous = previousCookie
      ? yield* sessions.verify(previousCookie).pipe(Effect.option)
      : undefined;
    return yield* sessions
      .issue({
        method,
        client,
        founder: identity.founder,
        subject: subjectFor(configured, identity.founder),
        expiresAt: DateTime.makeUnsafe(identity.expiresAt),
        scopes: [
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
          AuthFilesystemReadScope,
        ],
        ...(previous?._tag === "Some" && previous.value.method === "browser-session-cookie"
          ? { replaceSessionId: previous.value.sessionId }
          : {}),
      })
      .pipe(Effect.mapError(unavailable));
  });

  const startDesktop = Effect.fn("WorkOsAuth.startDesktop")(function* (
    token: string,
    verifierChallenge: string,
  ) {
    if (!config)
      return yield* new WorkOsError({ status: 404, message: "WorkOS sign-in is disabled." });
    yield* requireDesktopBootstrap(token);
    if (!isOpaque(verifierChallenge)) return yield* invalid();
    const now = (yield* DateTime.now).epochMilliseconds;
    for (const [id, transaction] of desktop) if (transaction.expiresAt <= now) desktop.delete(id);
    if (desktop.size >= maxPending)
      return yield* new WorkOsError({ status: 429, message: "Too many pending sign-ins." });
    const id = opaque();
    desktop.set(id, {
      challenge: verifierChallenge,
      expiresAt: now + transactionLifetimeMs,
      started: false,
    });
    return id;
  });

  const begin = Effect.fn("WorkOsAuth.begin")(function* (desktopId: string | null) {
    if (!config)
      return yield* new WorkOsError({ status: 404, message: "WorkOS sign-in is disabled." });
    if (!ManagedLimits.allowsRemoteClients(managedPolicy)) return yield* remoteClientsDisallowed();
    const now = (yield* DateTime.now).epochMilliseconds;
    const pending = desktopId ? desktop.get(desktopId) : undefined;
    if (desktopId && (!pending || pending.expiresAt <= now || pending.started))
      return yield* invalid();
    for (const [state, transaction] of browser)
      if (transaction.expiresAt <= now) browser.delete(state);
    if (browser.size >= maxPending)
      return yield* new WorkOsError({ status: 429, message: "Too many pending sign-ins." });
    if (pending) pending.started = true;
    const state = opaque();
    const verifier = opaque();
    browser.set(state, {
      verifier,
      expiresAt: now + transactionLifetimeMs,
      ...(pending ? { desktop: pending } : {}),
    });
    const location = new URL("/user_management/authorize", workOsApi);
    location.search = new URLSearchParams({
      provider: "authkit",
      client_id: config.clientId,
      redirect_uri: `${config.origin}${WORKOS_PATH}/callback`,
      response_type: "code",
      state,
      code_challenge: challenge(verifier),
      code_challenge_method: "S256",
      ...(config.organizationId ? { organization_id: config.organizationId } : {}),
    }).toString();
    return { state, location };
  });

  const callback: WorkOsAuth["Service"]["callback"] = Effect.fn("WorkOsAuth.callback")(
    function* (input) {
      if (!config || !key)
        return yield* new WorkOsError({ status: 404, message: "WorkOS sign-in is disabled." });
      if (!ManagedLimits.allowsRemoteClients(managedPolicy))
        return yield* remoteClientsDisallowed();
      const transaction = browser.get(input.state);
      const now = (yield* DateTime.now).epochMilliseconds;
      if (!transaction || transaction.expiresAt <= now || input.state !== input.challengeCookie)
        return yield* invalid();
      browser.delete(input.state);
      if (!input.code || input.code.length > 2048) return yield* invalid();
      const request = yield* HttpClientRequest.post(
        `${workOsApi}/user_management/authenticate`,
      ).pipe(
        HttpClientRequest.bodyJson({
          grant_type: "authorization_code",
          client_id: config.clientId,
          client_secret: Redacted.value(config.apiKey),
          code: input.code,
          code_verifier: transaction.verifier,
        }),
        Effect.mapError(upstreamUnavailable),
      );
      const response = yield* http
        .execute(request)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.timeout("10 seconds"),
          Effect.mapError(upstreamUnavailable),
        );
      if (response.status < 200 || response.status >= 300) {
        return yield* response.status >= 500 || response.status === 429
          ? upstreamUnavailable()
          : invalid();
      }
      const body: unknown = yield* response.json.pipe(Effect.mapError(upstreamUnavailable));
      const identity = yield* verifyCodeResponse(config, key, body);
      if (transaction.desktop) {
        transaction.desktop.identity = identity;
        return null;
      }
      return yield* issue(
        config,
        identity,
        input.client,
        "browser-session-cookie",
        input.previousCookie,
      );
    },
  );

  const finishDesktop = Effect.fn("WorkOsAuth.finishDesktop")(function* (
    token: string,
    id: string,
    verifier: string,
  ) {
    if (!config)
      return yield* new WorkOsError({ status: 404, message: "WorkOS sign-in is disabled." });
    yield* requireDesktopBootstrap(token);
    const pending = desktop.get(id);
    const now = (yield* DateTime.now).epochMilliseconds;
    if (
      !pending ||
      pending.expiresAt <= now ||
      !isOpaque(verifier) ||
      challenge(verifier) !== pending.challenge
    ) {
      return yield* invalid();
    }
    if (!pending.identity)
      return yield* new WorkOsError({
        status: 409,
        message: "Finish Google sign-in in your browser first.",
      });
    desktop.delete(id);
    return yield* issue(
      config,
      pending.identity,
      { label: "T3 Code Desktop", deviceType: "desktop" },
      "bearer-access-token",
    );
  });

  const signOut = Effect.fn("WorkOsAuth.signOut")(function* (token: string) {
    const session = yield* sessions.verify(token).pipe(Effect.mapError(invalid));
    if (
      !config ||
      !(
        session.subject === subjectFor(config, "kameron") ||
        session.subject === subjectFor(config, "jeff")
      )
    ) {
      return yield* denied();
    }
    yield* sessions.revoke(session.sessionId).pipe(Effect.mapError(unavailable));
  });

  return WorkOsAuth.of({ config, startDesktop, begin, callback, finishDesktop, signOut });
});

export const layer = Layer.effect(WorkOsAuth, make).pipe(Layer.provide(FetchHttpClient.layer));
