import type { OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";

import type { ThreadStatusPill } from "../Sidebar.logic";
import type { BotAvatarState } from "./BotAvatar";
import { isChiefOfStaff, isFounderName } from "./botOrgTree";

function isFounderStanding(standing: unknown): boolean {
  const name = (standing as { name?: unknown } | null)?.name;
  return typeof name === "string" && isFounderName(name);
}

export interface BotPresence {
  readonly avatarState: BotAvatarState;
  /** Second line: what the bot is doing, or its role when there is nothing newer. */
  readonly line: string | null;
  /** The trailing badge: a count-free dot for needs-you or unread. */
  readonly badge: "needs-you" | "unread" | null;
}

const NEEDS_YOU = new Set(["Pending Approval", "Awaiting Input", "Guest Request", "Plan Ready"]);

/** The pill plus the failure class, which the pill label does not carry. */
export type BotPresenceInput = Pick<ThreadStatusPill, "label"> & {
  readonly errorClass?: OrchestrationV2ProviderFailureClass | null | undefined;
};

/**
 * The bot's pill, or a quota block when its runtime is out of provider quota. Like a thread row's
 * Limited status, a quota block stays after the failure is seen: the bot cannot work until it ends.
 */
export function botPresenceInput(
  pill: Pick<ThreadStatusPill, "label"> | null,
  runtime:
    | {
        readonly status: string;
        readonly lastErrorClass?: OrchestrationV2ProviderFailureClass | null | undefined;
      }
    | null
    | undefined,
): BotPresenceInput | null {
  if (runtime?.status === "failed" && runtime.lastErrorClass === "usage_limit" && pill === null)
    return { label: "Failed", errorClass: "usage_limit" };
  return pill === null ? null : { ...pill, errorClass: runtime?.lastErrorClass };
}

/** Maps the thread's status pill onto a bot's quieter vocabulary. */
export function resolveBotPresence(
  pill: BotPresenceInput | null,
  role: string | null | undefined,
): BotPresence {
  const label = pill?.label ?? null;
  if (label !== null && NEEDS_YOU.has(label))
    return { avatarState: "needs-you", line: label, badge: "needs-you" };
  if (label === "Working" || label === "Connecting")
    return { avatarState: "running", line: label, badge: null };
  // A usage limit is the bot waiting, not a failure: a calm glow, no failure ring.
  if (label === "Failed" && pill?.errorClass === "usage_limit")
    return { avatarState: "waiting", line: "Blocked · quota", badge: null };
  if (label === "Failed") return { avatarState: "failed", line: "Failed", badge: null };
  if (label === "Completed")
    return { avatarState: "idle", line: role ?? "New reply", badge: "unread" };
  if (label === "Waiting") return { avatarState: "waiting", line: "Waiting", badge: null };
  return { avatarState: "idle", line: role ?? null, badge: null };
}

/** Bots list alphabetically by persona name, so their places never move. */
export function sortBotThreads<
  T extends { readonly standing: { readonly name: string } | null; readonly id: string },
>(threads: readonly T[]): T[] {
  return threads.toSorted(
    (left, right) =>
      (left.standing?.name ?? "").localeCompare(right.standing?.name ?? "", undefined, {
        sensitivity: "base",
      }) || left.id.localeCompare(right.id),
  );
}

/**
 * Splits standing bots out of the sidebar's thread list. Bots go to their own group whatever
 * their pin, settle or snooze state; everything else continues to the ordinary sections.
 */
export function splitStandingThreads<T extends { readonly standing: unknown }>(
  threads: readonly T[],
): { readonly bots: T[]; readonly rest: T[] } {
  const bots: T[] = [];
  const rest: T[] = [];
  for (const thread of threads) {
    // A founder is a human, not a bot: founder-to-founder threads stay out of the Bots shelf.
    const isBot = thread.standing != null && !isFounderStanding(thread.standing);
    (isBot ? bots : rest).push(thread);
  }
  return { bots, rest };
}

type Founder = "kameron" | "jeff";

interface GroupableBot {
  readonly standing: { readonly name: string } | null;
  readonly source: {
    readonly inbox?: {
      readonly audience?: string;
      readonly owner?: string | null;
    } | null;
  };
}

const asFounder = (value: string | null | undefined): Founder | undefined =>
  value === "kameron" || value === "jeff" ? value : undefined;

/**
 * The three bot groups. My bots are filed to the viewer's own inbox, Teammate bots to the other
 * founder's, and Closura bots are everything else (Shared, Agents or no inbox). Without a viewer
 * every non-shared bot is My bots. A founder's CoS is personal: it lists only for that founder or
 * when their inbox is among `shownInboxes`. Its founder is its inbox, else the machine it runs on.
 */
export function partitionBotGroups<T extends GroupableBot>(
  threads: readonly T[],
  viewer?: Founder,
  scope?: {
    readonly shownInboxes: ReadonlyArray<string>;
    readonly machineOwnerOf: (thread: T) => Founder | undefined;
  },
): { readonly mine: T[]; readonly closura: T[]; readonly teammates: T[] } {
  const mine: T[] = [];
  const closura: T[] = [];
  const teammates: T[] = [];
  for (const thread of threads) {
    const inbox = thread.source.inbox;
    const audience = inbox?.audience;
    if (scope !== undefined && isChiefOfStaff(thread.standing?.name)) {
      const founder =
        asFounder(audience) ?? asFounder(inbox?.owner) ?? scope.machineOwnerOf(thread);
      if (founder !== undefined && founder !== viewer && !scope.shownInboxes.includes(founder))
        continue;
    }
    if (audience === "shared") closura.push(thread);
    else if (viewer === undefined || audience === viewer) mine.push(thread);
    else if (asFounder(audience) !== undefined) teammates.push(thread);
    else closura.push(thread);
  }
  return { mine, closura, teammates };
}
