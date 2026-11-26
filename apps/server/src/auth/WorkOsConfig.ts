// @effect-diagnostics nodeBuiltinImport:off - The session subject is computed synchronously from immutable configuration.
import * as NodeCrypto from "node:crypto";
import type { Founder } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

export const WORKOS_PATH = "/api/auth/workos";
export const WORKOS_SUBJECT_PREFIX = "workos:";
const userIdPattern = /^user_[A-Za-z0-9]+$/;

export interface WorkOsConfig {
  readonly clientId: string;
  readonly apiKey: Redacted.Redacted<string>;
  readonly origin: string;
  readonly issuer: string;
  readonly organizationId: string | undefined;
  readonly founders: Readonly<Record<Founder, { readonly id: string; readonly email: string }>>;
}

const isHttpsUrl = (value: string) => {
  const url = URL.parse(value);
  return url?.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
};

const fromEnv = Config.all({
  clientId: Config.String("T3CODE_WORKOS_CLIENT_ID"),
  apiKey: Config.Redacted("T3CODE_WORKOS_API_KEY"),
  origin: Config.String("T3CODE_WORKOS_ORIGIN"),
  issuer: Config.String("T3CODE_WORKOS_ISSUER"),
  organizationId: Config.String("T3CODE_WORKOS_ORGANIZATION_ID").pipe(Config.option),
  kameronId: Config.String("T3CODE_WORKOS_KAMERON_USER_ID"),
  jeffId: Config.String("T3CODE_WORKOS_JEFF_USER_ID"),
  kameronEmail: Config.String("T3CODE_WORKOS_KAMERON_EMAIL"),
  jeffEmail: Config.String("T3CODE_WORKOS_JEFF_EMAIL"),
});

export const readConfig = Effect.gen(function* () {
  const enabled = yield* Config.Boolean("T3CODE_WORKOS_AUTH_ENABLED").pipe(
    Config.withDefault(false),
    Effect.orElseSucceed(() => false),
  );
  if (!enabled) return null;
  const raw = yield* fromEnv.pipe(Effect.option);
  if (Option.isSome(raw)) {
    const { clientId, apiKey, origin, issuer, organizationId, kameronId, jeffId } = raw.value;
    const kameronEmail = raw.value.kameronEmail.trim().toLowerCase();
    const jeffEmail = raw.value.jeffEmail.trim().toLowerCase();
    if (
      /^client_[A-Za-z0-9]+$/.test(clientId) &&
      Redacted.value(apiKey).trim() &&
      isHttpsUrl(origin) &&
      new URL(origin).origin === origin &&
      isHttpsUrl(issuer) &&
      userIdPattern.test(kameronId) &&
      userIdPattern.test(jeffId) &&
      kameronId !== jeffId &&
      kameronEmail.includes("@") &&
      jeffEmail.includes("@") &&
      kameronEmail !== jeffEmail &&
      (Option.isNone(organizationId) || /^org_[A-Za-z0-9]+$/.test(organizationId.value))
    ) {
      return {
        clientId,
        apiKey,
        origin,
        issuer,
        organizationId: Option.getOrUndefined(organizationId),
        founders: {
          kameron: { id: kameronId, email: kameronEmail },
          jeff: { id: jeffId, email: jeffEmail },
        },
      } satisfies WorkOsConfig;
    }
  }
  yield* Effect.logWarning(
    "WorkOS sign-in is disabled because its server configuration is incomplete or invalid.",
  );
  return null;
});

export function subjectFor(config: WorkOsConfig, founder: Founder): string {
  const { id, email } = config.founders[founder];
  return (
    WORKOS_SUBJECT_PREFIX +
    NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify([config.issuer, config.clientId, config.organizationId, founder, id, email]),
      )
      .digest("base64url")
  );
}
