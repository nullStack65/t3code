import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A standing thread is a long-lived bot lane (Lead, a designer, a CTO) rather
 * than a unit of work. It is independent of pinning: pinning is the user's
 * watch list, standing is what the thread is.
 */

/** Built-in avatars clients ship. Unknown ids from a newer peer fall back to the first one. */
export const THREAD_STANDING_AVATAR_IDS = [
  "bolt",
  "dish",
  "visor",
  "cyclops",
  "periscope",
  "twin",
  "sprout",
  "halo",
  "grill",
  "monocle",
] as const;
export type ThreadStandingAvatarId = (typeof THREAD_STANDING_AVATAR_IDS)[number];

/** Named accents; clients map each to theme-tuned colors for light and dark. */
export const THREAD_STANDING_ACCENTS = [
  "sky",
  "violet",
  "emerald",
  "amber",
  "rose",
  "teal",
  "indigo",
  "orange",
] as const;
export type ThreadStandingAccent = (typeof THREAD_STANDING_ACCENTS)[number];

const singleLine = (max: number) =>
  TrimmedNonEmptyString.check(
    Schema.isMaxLength(max),
    Schema.makeFilter((value) =>
      /[\p{Cc}]/u.test(value) ? "Must be a single line of text." : true,
    ),
  );

/** What a client or tool may write. */
export const ThreadStanding = Schema.Struct({
  name: singleLine(40),
  /** One-line description shown under the name when the bot has nothing newer to say. */
  role: Schema.optional(Schema.NullOr(singleLine(80))),
  avatarId: Schema.Literals(THREAD_STANDING_AVATAR_IDS),
  accent: Schema.Literals(THREAD_STANDING_ACCENTS),
});
export type ThreadStanding = typeof ThreadStanding.Type;

/**
 * Standing read back from storage or a peer. Avatar and accent stay plain
 * strings so a newer peer's ids never fail a whole thread; a value that does
 * not decode at all reads as an ordinary thread.
 */
export const StoredThreadStanding = Schema.NullOr(
  Schema.Struct({
    name: Schema.String,
    role: Schema.optional(Schema.NullOr(Schema.String)),
    avatarId: Schema.String,
    accent: Schema.String,
  }),
).pipe(Schema.catchDecoding(() => Effect.succeedSome(null)));
export type StoredThreadStanding = typeof StoredThreadStanding.Type;

export function resolveThreadStandingAvatarId(avatarId: string): ThreadStandingAvatarId {
  return (THREAD_STANDING_AVATAR_IDS as readonly string[]).includes(avatarId)
    ? (avatarId as ThreadStandingAvatarId)
    : THREAD_STANDING_AVATAR_IDS[0];
}

export function resolveThreadStandingAccent(accent: string): ThreadStandingAccent {
  return (THREAD_STANDING_ACCENTS as readonly string[]).includes(accent)
    ? (accent as ThreadStandingAccent)
    : THREAD_STANDING_ACCENTS[0];
}
