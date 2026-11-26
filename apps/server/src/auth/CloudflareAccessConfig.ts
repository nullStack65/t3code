// @effect-diagnostics nodeBuiltinImport:off - The session subject is computed synchronously from immutable configuration.
import * as NodeCrypto from "node:crypto";
import type { Founder } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export const CLOUDFLARE_ACCESS_SUBJECT_PREFIX = "cf-access:";

const audiencePattern = /^[A-Za-z0-9_-]{16,128}$/;

export interface CloudflareAccessConfig {
  readonly teamDomain: string;
  readonly jwksUrl: URL;
  readonly audiences: ReadonlyArray<string>;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly founders: Readonly<Record<Founder, { readonly emails: ReadonlyArray<string> }>>;
}

const isHttpsOrigin = (value: string): boolean => {
  const url = URL.parse(value);
  return (
    url !== null &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.origin === value
  );
};

const parseList = (
  raw: string,
  normalize: (item: string) => string,
): ReadonlyArray<string> | null => {
  const parts = raw
    .split(",")
    .map((item) => normalize(item))
    .filter((item) => item.length > 0);
  if (parts.length === 0) return null;
  return Array.from(new Set(parts));
};

const parseEmailList = (raw: string): ReadonlyArray<string> | null => {
  const emails = parseList(raw, (item) => item.trim().toLowerCase());
  if (!emails) return null;
  for (const email of emails) {
    const at = email.indexOf("@");
    if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1 || /\s/.test(email)) {
      return null;
    }
  }
  return emails;
};

const fromEnv = Config.all({
  teamDomain: Config.String("T3CODE_CF_ACCESS_TEAM_DOMAIN"),
  audiences: Config.String("T3CODE_CF_ACCESS_AUD"),
  allowedOrigins: Config.String("T3CODE_CF_ACCESS_ALLOWED_ORIGINS"),
  kameronEmails: Config.String("T3CODE_CF_ACCESS_KAMERON_EMAIL"),
  jeffEmails: Config.String("T3CODE_CF_ACCESS_JEFF_EMAIL"),
});

export const readCloudflareAccessConfig = Effect.gen(function* () {
  const enabled = yield* Config.Boolean("T3CODE_CF_ACCESS_AUTH_ENABLED").pipe(
    Config.withDefault(false),
    Effect.orElseSucceed(() => false),
  );
  if (!enabled) return null;
  const raw = yield* fromEnv.pipe(Effect.option);
  if (Option.isSome(raw)) {
    const teamDomain = raw.value.teamDomain.trim().replace(/\/+$/, "");
    const audiences = parseList(raw.value.audiences, (item) => item.trim());
    const allowedOrigins = parseList(raw.value.allowedOrigins, (item) =>
      item.trim().replace(/\/+$/, ""),
    );
    const kameronEmails = parseEmailList(raw.value.kameronEmails);
    const jeffEmails = parseEmailList(raw.value.jeffEmails);
    const kameronSet = kameronEmails ? new Set(kameronEmails) : null;
    const emailsDisjoint =
      kameronSet !== null &&
      jeffEmails !== null &&
      jeffEmails.every((email) => !kameronSet.has(email));

    if (
      isHttpsOrigin(teamDomain) &&
      audiences !== null &&
      audiences.every((aud) => audiencePattern.test(aud)) &&
      allowedOrigins !== null &&
      allowedOrigins.every(isHttpsOrigin) &&
      kameronEmails !== null &&
      jeffEmails !== null &&
      emailsDisjoint
    ) {
      return {
        teamDomain,
        jwksUrl: new URL("/cdn-cgi/access/certs", teamDomain),
        audiences,
        allowedOrigins,
        founders: {
          kameron: { emails: kameronEmails },
          jeff: { emails: jeffEmails },
        },
      } satisfies CloudflareAccessConfig;
    }
  }
  yield* Effect.logWarning(
    "Cloudflare Access auto-session is disabled because its server configuration is incomplete or invalid.",
  );
  return null;
});

export function cloudflareAccessSubjectFor(
  config: CloudflareAccessConfig,
  founder: Founder,
): string {
  const { emails } = config.founders[founder];
  return (
    CLOUDFLARE_ACCESS_SUBJECT_PREFIX +
    NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify([
          config.teamDomain,
          [...config.audiences].toSorted(),
          [...config.allowedOrigins].toSorted(),
          founder,
          [...emails].toSorted(),
        ]),
      )
      .digest("base64url")
  );
}
