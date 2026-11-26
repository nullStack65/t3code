import {
  type Founder,
  isHiddenFromFounder,
  type OrchestrationV2ProviderFailureClass,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import type { ThreadStatusPill } from "../Sidebar.logic";
import type { BotAvatarState } from "./BotAvatar";
import { isFounderName } from "./botOrgTree";

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
    return { avatarState: "waiting", line: "Limited", badge: null };
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
export function splitStandingThreads<
  T extends Pick<EnvironmentThreadShell, "standing" | "lineage">,
>(threads: readonly T[]): { readonly bots: T[]; readonly rest: T[] } {
  const bots: T[] = [];
  const rest: T[] = [];
  for (const thread of threads) {
    const isChild =
      thread.lineage.parentThreadId !== null || thread.lineage.relationshipToParent === "subagent";
    // A founder is a human, not a bot: founder-to-founder threads stay out of the Bots shelf.
    const isBot = thread.standing != null && !isFounderStanding(thread.standing) && !isChild;
    (isBot ? bots : rest).push(thread);
  }
  return { bots, rest };
}

/** A shared bot belongs to both founders; every other standing bot is one's own. */
function isSharedBotThread(thread: {
  readonly source: { readonly inbox?: BotInbox | null | undefined };
}): boolean {
  return thread.source.inbox?.audience === "shared";
}

type BotInbox = {
  readonly owner?: Founder | null | undefined;
  readonly audience?: string | null | undefined;
};

/**
 * The three bot groups:
 * - `mine` ("My Bots"): the viewer's own personal bots (`audience === viewer`, or all personal bots when no viewer is set).
 * - `others` ("Others"): the other founder's personal bots (shown for Kameron; Jeff never lists Kameron's private bots via `isHiddenFromFounder`).
 * - `shared` ("Closura"): all company bots (`audience === "shared"`, `"agent-only"`, or missing).
 */
export function partitionBotGroups<
  T extends { readonly source: { readonly inbox?: BotInbox | null } },
>(
  threads: readonly T[],
  viewer?: Founder,
): { readonly mine: T[]; readonly others: T[]; readonly shared: T[] } {
  const mine: T[] = [];
  const others: T[] = [];
  const shared: T[] = [];
  for (const thread of threads) {
    if (isHiddenFromFounder(thread.source.inbox, viewer)) continue;
    const audience = thread.source.inbox?.audience;
    const isPersonal = audience === "kameron" || audience === "jeff";
    if (!isPersonal || isSharedBotThread(thread)) {
      shared.push(thread);
    } else if (viewer !== undefined && audience !== viewer) {
      others.push(thread);
    } else {
      mine.push(thread);
    }
  }
  return { mine, others, shared };
}
