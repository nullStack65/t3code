// @effect-diagnostics nodeBuiltinImport:off - PKCE is generated in the Electron main process.
import * as NodeCrypto from "node:crypto";
import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import type { RemoteEnvironmentRequestError } from "@t3tools/client-runtime/rpc";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";

// Each /oauth/token attempt may take 10 s, so a backend busy after ready needs several attempts.
const BOOTSTRAP_TRANSIENT_RETRY_TIMEOUT = Duration.seconds(60);
const BOOTSTRAP_TRANSIENT_RETRY_INTERVAL = Duration.millis(500);
const TRANSIENT_BOOTSTRAP_STATUS_CODES = new Set([502, 503, 504]);

const isTransientBearerBootstrapError = (error: RemoteEnvironmentRequestError): boolean => {
  switch (error._tag) {
    case "RemoteEnvironmentAuthFetchError":
    case "RemoteEnvironmentAuthTimeoutError":
      return true;
    case "RemoteEnvironmentAuthUndeclaredStatusError":
      return TRANSIENT_BOOTSTRAP_STATUS_CODES.has(error.status);
    default:
      return false;
  }
};

export class DesktopLocalEnvironmentAuthBackendNotConfiguredError extends Schema.TaggedError<DesktopLocalEnvironmentAuthBackendNotConfiguredError>()(
  "DesktopLocalEnvironmentAuthBackendNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Local backend is not configured.";
  }
}

export class DesktopLocalEnvironmentAuthSessionBootstrapError extends Schema.TaggedError<DesktopLocalEnvironmentAuthSessionBootstrapError>()(
  "DesktopLocalEnvironmentAuthSessionBootstrapError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to create the local desktop bearer session.";
  }
}

export const DesktopLocalEnvironmentAuthError = Schema.Union([
  DesktopLocalEnvironmentAuthBackendNotConfiguredError,
  DesktopLocalEnvironmentAuthSessionBootstrapError,
]);
export type DesktopLocalEnvironmentAuthError = typeof DesktopLocalEnvironmentAuthError.Type;

const DesktopStart = Schema.Struct({ id: Schema.String, authorizationUrl: Schema.String });
const DesktopFinish = Schema.Struct({ token: Schema.String, expiresAt: Schema.Number });
const decodeWorkOsStart = Schema.decodeUnknownEffect(DesktopStart);
const decodeWorkOsFinish = Schema.decodeUnknownEffect(DesktopFinish);

export class DesktopWorkOsRequestError extends Schema.TaggedError<DesktopWorkOsRequestError>()(
  "DesktopWorkOsRequestError",
  { message: Schema.String },
) {}

export class DesktopLocalEnvironmentAuth extends Context.Service<
  DesktopLocalEnvironmentAuth,
  {
    readonly getBearerToken: Effect.Effect<string, DesktopLocalEnvironmentAuthError>;
    readonly getRendererBearerToken: Effect.Effect<string, DesktopLocalEnvironmentAuthError>;
    readonly workOsAction: (
      action: "start" | "finish" | "logout",
      openExternal: ElectronShell.ElectronShell["Service"]["openExternal"],
    ) => Effect.Effect<void, DesktopLocalEnvironmentAuthError | DesktopWorkOsRequestError>;
  }
>()("@t3tools/desktop/backend/DesktopLocalEnvironmentAuth") {}

/** @public */
export const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const httpClient = yield* HttpClient.HttpClient;
  const mac = yield* Mac.Mac;
  const tokenRef = yield* Ref.make(Option.none<string>());
  const mutex = yield* Semaphore.make(1);
  const workOsMutex = yield* Semaphore.make(1);
  let pending:
    | { readonly base: string; readonly id: string; readonly verifier: string }
    | undefined;
  let verified:
    | { readonly base: string; readonly token: string; readonly expiresAt: number }
    | undefined;

  const primaryBackend = Effect.fn("DesktopLocalEnvironmentAuth.primaryBackend")(function* () {
    const instances = yield* pool.list;
    const primary = instances.find((instance) => instance.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
    if (primary === undefined || !(yield* primary.waitForReady(Duration.infinity))) {
      return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
    }
    const config = yield* primary.currentConfig;
    if (Option.isNone(config))
      return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
    return { primary, config: config.value };
  });

  const primaryConfig = () => primaryBackend().pipe(Effect.map(({ config }) => config));

  const getBearerToken = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        const cached = yield* Ref.get(tokenRef);
        if (Option.isSome(cached)) {
          return cached.value;
        }

        const { primary, config } = yield* primaryBackend();
        // Secret-authenticated backends accept the current window token; the launch token may be stale.
        const secret = config.bootstrap.desktopBootstrapSecret;
        const credential =
          secret === undefined
            ? config.bootstrap.desktopBootstrapToken
            : yield* currentDesktopBootstrapToken(secret, yield* Clock.currentTimeMillis).pipe(
                Effect.provideService(Mac.Mac, mac),
              );
        if (!credential) {
          return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
        }
        const exchange = Effect.gen(function* () {
          // Each attempt goes only to a backend that is currently ready.
          if (!(yield* primary.waitForReady(Duration.infinity))) {
            return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
          }
          return yield* bootstrapRemoteBearerSession({
            httpBaseUrl: config.httpBaseUrl.href,
            credential,
            clientMetadata: {
              label: "T3 Code Desktop",
              deviceType: "desktop",
            },
          }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
        });
        const session = yield* exchange.pipe(
          Effect.retry({
            while: (error) =>
              error._tag !== "DesktopLocalEnvironmentAuthBackendNotConfiguredError" &&
              isTransientBearerBootstrapError(error),
            schedule: Schedule.spaced(BOOTSTRAP_TRANSIENT_RETRY_INTERVAL),
          }),
          Effect.timeout(BOOTSTRAP_TRANSIENT_RETRY_TIMEOUT),
          Effect.mapError((cause) =>
            cause._tag === "DesktopLocalEnvironmentAuthBackendNotConfiguredError"
              ? cause
              : new DesktopLocalEnvironmentAuthSessionBootstrapError({ cause }),
          ),
        );
        yield* Ref.set(tokenRef, Option.some(session.access_token));
        return session.access_token;
      }),
    )
    .pipe(Effect.withSpan("desktop.localEnvironmentAuth.getBearerToken"));

  const getRendererBearerToken = Effect.gen(function* () {
    if (verified && verified.expiresAt > (yield* Clock.currentTimeMillis)) {
      const current = yield* primaryConfig();
      if (current.httpBaseUrl.href === verified.base) return verified.token;
    }
    return yield* getBearerToken;
  });

  const requestWorkOs = Effect.fn("DesktopLocalEnvironmentAuth.requestWorkOs")(function* (
    base: string,
    path: "desktop/start" | "desktop/finish" | "logout",
    token: string,
    body?: object,
  ) {
    const unavailable = () =>
      new DesktopWorkOsRequestError({ message: "Could not reach the local T3 Code server." });
    const request = HttpClientRequest.post(new URL(`/api/auth/workos/${path}`, base)).pipe(
      HttpClientRequest.bearerToken(token),
    );
    const prepared = body
      ? yield* HttpClientRequest.bodyJson(request, body).pipe(Effect.mapError(unavailable))
      : request;
    const response = yield* httpClient
      .execute(prepared)
      .pipe(Effect.timeout("10 seconds"), Effect.mapError(unavailable));
    if (response.status < 200 || response.status >= 300) {
      return yield* new DesktopWorkOsRequestError({
        message:
          response.status === 409
            ? "Finish Google sign-in in your browser first."
            : "Google sign-in could not be completed. Start again.",
      });
    }
    if (response.status === 204) return undefined;
    return yield* response.json.pipe(Effect.mapError(unavailable));
  });

  const workOsAction: DesktopLocalEnvironmentAuth["Service"]["workOsAction"] = Effect.fn(
    "DesktopLocalEnvironmentAuth.workOsAction",
  )(function* (action, openExternal) {
    const base = (yield* primaryConfig()).httpBaseUrl.href;
    const invalidResponse = () =>
      new DesktopWorkOsRequestError({
        message: "The local server returned an invalid sign-in response.",
      });
    if (action === "logout") {
      if (verified?.base === base && verified.expiresAt > (yield* Clock.currentTimeMillis)) {
        yield* requestWorkOs(base, "logout", verified.token);
      }
      verified = undefined;
      pending = undefined;
      return;
    }
    const token = yield* getBearerToken;
    if (action === "start") {
      const verifier = NodeCrypto.randomBytes(32).toString("base64url");
      const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
      const result = yield* requestWorkOs(base, "desktop/start", token, { challenge });
      const { id, authorizationUrl } = yield* decodeWorkOsStart(result).pipe(
        Effect.mapError(invalidResponse),
      );
      const url = URL.parse(authorizationUrl);
      if (
        url?.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/api/auth/workos/start" ||
        url.searchParams.get("desktop") !== id
      ) {
        return yield* invalidResponse();
      }
      if (!(yield* openExternal(url.href))) {
        return yield* new DesktopWorkOsRequestError({
          message: "Could not open your system browser.",
        });
      }
      pending = { base, id, verifier };
      return;
    }
    if (!pending || pending.base !== base) {
      return yield* new DesktopWorkOsRequestError({ message: "Start Google sign-in again." });
    }
    const { id, verifier } = pending;
    const result = yield* requestWorkOs(base, "desktop/finish", token, { id, verifier });
    const session = yield* decodeWorkOsFinish(result).pipe(Effect.mapError(invalidResponse));
    verified = { base, ...session };
    pending = undefined;
  }, workOsMutex.withPermits(1));

  return DesktopLocalEnvironmentAuth.of({ getBearerToken, getRendererBearerToken, workOsAction });
});

export const layer = Layer.effect(DesktopLocalEnvironmentAuth, make);
