import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { requestUrl } from "../requestUrl.ts";
import { parseBearerToken } from "./EnvironmentAuth.ts";
import * as SessionStore from "./SessionStore.ts";
import { deriveAuthClientMetadata } from "./utils.ts";
import * as WorkOsAuth from "./WorkOsAuth.ts";
import { WORKOS_PATH } from "./WorkOsConfig.ts";

const cookieOptions = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;
const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" } as const;

const route = <E, R>(
  method: "GET" | "POST",
  path: string,
  handle: (input: {
    request: HttpServerRequest.HttpServerRequest;
    auth: WorkOsAuth.WorkOsAuth["Service"];
    origin: string;
    url: URL;
  }) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  HttpRouter.add(
    method,
    `${WORKOS_PATH}/${path}`,
    HttpMiddleware.withLoggerDisabled(
      Effect.gen(function* () {
        const auth = yield* WorkOsAuth.WorkOsAuth;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = requestUrl(request);
        if (!auth.config) return HttpServerResponse.empty({ status: 404 });
        if (Option.isNone(url)) return HttpServerResponse.empty({ status: 403 });
        return yield* handle({ request, auth, origin: auth.config.origin, url: url.value });
      }).pipe(
        Effect.catchIf(Schema.is(WorkOsAuth.WorkOsError), (error) =>
          Effect.succeed(HttpServerResponse.text(error.message, { status: error.status })),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Could not complete Google sign-in.", { status: 500 }),
        ),
        Effect.map(HttpServerResponse.setHeaders(headers)),
      ),
    ),
  );

const browserStart = (method: "GET" | "POST") =>
  route(method, "start", ({ auth, request, origin, url }) =>
    Effect.gen(function* () {
      const desktop = url.searchParams.get("desktop");
      if (
        url.origin !== origin ||
        (method === "POST" ? request.headers.origin !== origin || desktop !== null : !desktop)
      ) {
        return HttpServerResponse.empty({ status: 403 });
      }
      const { state, location } = yield* auth.begin(desktop);
      return yield* HttpServerResponse.redirect(location, { status: 303 }).pipe(
        HttpServerResponse.setCookie(WorkOsAuth.transactionCookie, state, {
          ...cookieOptions,
          maxAge: 300,
        }),
      );
    }),
  );

const callback = route("GET", "callback", ({ request, auth, origin, url }) =>
  Effect.gen(function* () {
    if (url.origin !== origin) return HttpServerResponse.empty({ status: 403 });
    const sessions = yield* SessionStore.SessionStore;
    const previousCookie = request.cookies[sessions.cookieName];
    const result = yield* auth.callback({
      state: url.searchParams.get("state") ?? "",
      challengeCookie: request.cookies[WorkOsAuth.transactionCookie] ?? "",
      code: url.searchParams.get("code") ?? "",
      client: deriveAuthClientMetadata({ request }),
      ...(previousCookie ? { previousCookie } : {}),
    });
    const response = result
      ? yield* HttpServerResponse.redirect(`${origin}/`, { status: 303 }).pipe(
          HttpServerResponse.setCookie(sessions.cookieName, result.token, {
            ...cookieOptions,
            expires: DateTime.toDate(result.expiresAt),
          }),
        )
      : HttpServerResponse.redirect(`${origin}${WORKOS_PATH}/desktop-complete`, { status: 303 });
    return yield* response.pipe(
      HttpServerResponse.setCookie(WorkOsAuth.transactionCookie, "", {
        ...cookieOptions,
        maxAge: 0,
      }),
    );
  }),
);

const desktopComplete = route("GET", "desktop-complete", ({ origin, url }) =>
  Effect.succeed(
    url.origin === origin
      ? HttpServerResponse.text(
          "Google verified your account. Return to T3 Code and choose Finish sign-in.",
        )
      : HttpServerResponse.empty({ status: 403 }),
  ),
);

const desktopStartBody = HttpServerRequest.schemaBodyJson(
  Schema.Struct({ challenge: Schema.String }),
);
const desktopFinishBody = HttpServerRequest.schemaBodyJson(
  Schema.Struct({ id: Schema.String, verifier: Schema.String }),
);
const desktopStart = route("POST", "desktop/start", ({ auth, request, origin }) =>
  Effect.gen(function* () {
    const token = parseBearerToken(request);
    if (!token || request.headers.origin !== undefined)
      return HttpServerResponse.empty({ status: 403 });
    const { challenge } = yield* desktopStartBody;
    const id = yield* auth.startDesktop(token, challenge);
    return HttpServerResponse.jsonUnsafe({
      id,
      authorizationUrl: `${origin}${WORKOS_PATH}/start?desktop=${id}`,
    });
  }),
);

const desktopFinish = route("POST", "desktop/finish", ({ auth, request }) =>
  Effect.gen(function* () {
    const token = parseBearerToken(request);
    if (!token || request.headers.origin !== undefined)
      return HttpServerResponse.empty({ status: 403 });
    const { id, verifier } = yield* desktopFinishBody;
    const session = yield* auth.finishDesktop(token, id, verifier);
    return HttpServerResponse.jsonUnsafe({
      token: session.token,
      expiresAt: session.expiresAt.epochMilliseconds,
    });
  }),
);

const logout = route("POST", "logout", ({ auth, request, origin, url }) =>
  Effect.gen(function* () {
    const bearer = parseBearerToken(request);
    if (bearer && request.headers.origin === undefined) {
      yield* auth.signOut(bearer);
      return HttpServerResponse.empty({ status: 204 });
    }
    if (request.headers.origin !== origin || url.origin !== origin)
      return HttpServerResponse.empty({ status: 403 });
    const sessions = yield* SessionStore.SessionStore;
    const token = request.cookies[sessions.cookieName];
    if (token) yield* auth.signOut(token);
    return yield* HttpServerResponse.redirect(`${origin}/pair`, { status: 303 }).pipe(
      HttpServerResponse.setCookie(sessions.cookieName, "", { ...cookieOptions, maxAge: 0 }),
    );
  }),
);

export const layer = Layer.mergeAll(
  browserStart("GET"),
  browserStart("POST"),
  callback,
  desktopComplete,
  desktopStart,
  desktopFinish,
  logout,
);
